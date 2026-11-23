-- ROTAS CARBONITA: turnos, contatos dos responsáveis e ciclos de advertências.
-- Execute TODO o arquivo no SQL Editor do projeto existente. Não reinstala o banco.
-- Conserva estudantes, QR codes, chamadas, rotas, contas e senhas já cadastradas.
begin;
select pg_advisory_xact_lock(hashtextextended('rotas:catalog',0));
alter table public.estudantes add column if not exists turnos text[] not null default '{}';
alter table public.estudantes add column if not exists "contatosResponsaveis" jsonb not null default '[]';

create or replace function private.br_whatsapp(value text) returns text language plpgsql immutable set search_path = '' as $$
declare digits text:=regexp_replace(coalesce(value,''),'[^0-9]','','g');
begin
  if length(digits) in (12,13) and left(digits,2)='55' then digits:=substr(digits,3); end if;
  if digits !~ '^[1-9][0-9][2-9][0-9]{7,8}$' then return null; end if;
  return '55'||digits;
end $$;
create or replace function private.student_feature_fields(item jsonb,required boolean default false) returns jsonb
language plpgsql set search_path = '' as $$
declare result jsonb:='{}'; turns text[]; entry jsonb; contacts jsonb:='[]'; phone text; used text[]:='{}'; contact_id uuid;
begin
  if required or item ? 'turnos' then
    if jsonb_typeof(item->'turnos') is distinct from 'array' then raise exception 'Selecione Manhã, Tarde ou os dois turnos.'; end if;
    select array_agg(distinct v order by v) into turns from jsonb_array_elements_text(item->'turnos') v;
    if coalesce(cardinality(turns),0)=0 or not turns <@ array['MANHA','TARDE'] or array_position(turns,null) is not null then
      raise exception 'Selecione Manhã, Tarde ou os dois turnos.';
    end if;
    result:=result||jsonb_build_object('turnos',turns);
  end if;
  if required or item ? 'contatosResponsaveis' then
    if jsonb_typeof(item->'contatosResponsaveis') is distinct from 'array' then raise exception 'Cadastre pelo menos um responsável com WhatsApp e DDD.'; end if;
    if jsonb_array_length(item->'contatosResponsaveis') not between 1 and 20 then raise exception 'Cadastre entre 1 e 20 contatos de responsáveis.'; end if;
    for entry in select value from jsonb_array_elements(item->'contatosResponsaveis') loop
      phone:=private.br_whatsapp(entry->>'telefone');
      if phone is null then raise exception 'Informe um telefone brasileiro com DDD e 10 ou 11 dígitos.'; end if;
      if phone=any(used) then raise exception 'Este número de WhatsApp já está cadastrado para o estudante.'; end if;
      used:=array_append(used,phone);
      begin contact_id:=coalesce(nullif(entry->>'id','')::uuid,gen_random_uuid());
      exception when invalid_text_representation then raise exception 'Contato inválido. Reabra o cadastro.'; end;
      contacts:=contacts||jsonb_build_array(jsonb_build_object('id',contact_id,
        'nome',private.clean(entry->>'nome',140,true),'parentesco',private.clean(entry->>'parentesco',60),'telefone',phone));
    end loop;
    result:=result||jsonb_build_object('contatosResponsaveis',contacts,
      'responsavel',contacts#>>'{0,nome}','celular','+'||(contacts#>>'{0,telefone}'));
  end if;
  return result;
end $$;

-- Só migra turnos que já estavam identificados na turma; não presume o contraturno.
update public.estudantes s set turnos=case when private.name_key(t.turno) in ('manha','matutino') then array['MANHA']
  when private.name_key(t.turno) in ('tarde','vespertino') then array['TARDE'] end
from public.turmas t where t.id=s."turmaId" and cardinality(s.turnos)=0
  and private.name_key(t.turno) in ('manha','matutino','tarde','vespertino');
update public.estudantes s set "contatosResponsaveis"=jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),
  'nome',coalesce(nullif(s.responsavel,''),'Responsável'),'parentesco','','telefone',private.br_whatsapp(s.celular)))
where s."contatosResponsaveis"='[]' and private.br_whatsapp(s.celular) is not null;

create table if not exists public.advertencia_ciclos (
  id text primary key default gen_random_uuid()::text,"estudanteId" text not null references public.estudantes,
  numero integer not null check(numero>0),contador integer not null default 0 check(contador between 0 and 3),
  status text not null default 'ABERTO' check(status in ('ABERTO','PENDENTE_ASSINATURA','ENCERRADO')),
  "criadoEm" timestamptz not null default now(),"assinadoEm" timestamptz,"assinadoPor" text references public.usuarios,
  "nomeAssinante" text not null default '',unique("estudanteId",numero),
  check((status='ABERTO' and contador<3 and "assinadoEm" is null)
    or (status='PENDENTE_ASSINATURA' and contador=3 and "assinadoEm" is null)
    or (status='ENCERRADO' and contador=3 and "assinadoEm" is not null and "assinadoPor" is not null and "nomeAssinante"<>''))
);
create unique index if not exists advertencia_ciclo_ativo on public.advertencia_ciclos("estudanteId") where status<>'ENCERRADO';
create table if not exists public.advertencias (
  id text primary key default gen_random_uuid()::text,"cicloId" text not null references public.advertencia_ciclos,
  "estudanteId" text not null references public.estudantes,"escolaId" text not null references public.escolas,
  "rotaId" text references public.rotas,numero integer not null check(numero between 1 and 3),
  motivo text not null check(length(trim(motivo)) between 1 and 800),"criadoEm" timestamptz not null default now(),
  "usuarioId" text not null references public.usuarios,"requestId" uuid not null unique,unique("cicloId",numero)
);
create index if not exists advertencias_estudante on public.advertencias("estudanteId","criadoEm");
alter table public.advertencias enable row level security;
alter table public.advertencia_ciclos enable row level security;
revoke all on public.advertencias,public.advertencia_ciclos from public,anon,authenticated;

create or replace function private.feature_student(u public.usuarios,student_id text,require_active boolean default false) returns public.estudantes
language plpgsql stable set search_path = '' as $$
declare s public.estudantes;
begin
  select * into s from public.estudantes where id=student_id;
  if s.id is null or (require_active and not s.ativo) or not (
    u.perfil='secretaria' or (u.perfil='escola' and u."escolaId"=s."escolaId")
    or (u.perfil='monitor' and s.ativo and exists(select 1 from public.rotas r join public.atribuicoes a
      on private.main_route(a."rotaId")=r.id and a.ano=s.ano and a."usuarioId"=u.id
      where r.id=private.main_route(s."rotaId") and r.ativo and s."escolaId"=any(r."escolaIds")))
  ) then raise exception 'Estudante fora do seu acesso autorizado ou inativo.' using errcode='42501'; end if;
  return s;
end $$;

create or replace function private.warning_history(u public.usuarios,student_id text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare s public.estudantes; current_cycle public.advertencia_ciclos; school_name text; cycles jsonb; message_text text:=''; entry record; next_number integer;
begin
  s:=private.feature_student(u,student_id);
  select nome into school_name from public.escolas where id=s."escolaId";
  select * into current_cycle from public.advertencia_ciclos where "estudanteId"=s.id and status<>'ENCERRADO';
  select coalesce(max(numero),0)+1 into next_number from public.advertencia_ciclos where "estudanteId"=s.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'number',c.numero,'count',c.contador,'status',c.status,
    'createdAt',c."criadoEm",'signedAt',c."assinadoEm",'signerName',c."nomeAssinante",
    'confirmedBy',(select nome from public.usuarios where id=c."assinadoPor"),
    'warnings',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'number',w.numero,'reason',w.motivo,
      'createdAt',w."criadoEm",'date',to_char(w."criadoEm" at time zone 'America/Sao_Paulo','YYYY-MM-DD'),
      'registeredBy',(select nome from public.usuarios where id=w."usuarioId")) order by w.numero),'[]')
      from public.advertencias w where w."cicloId"=c.id)) order by c.numero desc),'[]') into cycles
    from public.advertencia_ciclos c where c."estudanteId"=s.id;
  if current_cycle.status='PENDENTE_ASSINATURA' then
    message_text:=E'COMUNICAÇÃO AOS PAIS OU RESPONSÁVEIS\nRotas Carbonita — Secretaria Municipal de Educação\n\nEstudante: '||s.nome||E'\nEscola: '||school_name||
      E'\n\nInformamos que o(a) estudante completou três advertências no transporte escolar neste ciclo. Seguem as ocorrências registradas:\n';
    for entry in select * from public.advertencias where "cicloId"=current_cycle.id order by numero loop
      message_text:=message_text||E'\n'||entry.numero||'ª advertência — '||to_char(entry."criadoEm" at time zone 'America/Sao_Paulo','DD/MM/YYYY')||E'\nMotivo: '||entry.motivo||E'\n';
    end loop;
    message_text:=message_text||E'\nSolicitamos que os pais ou responsáveis entrem em contato com a Secretaria Municipal de Educação de Carbonita para combinar o comparecimento presencial e realizar a assinatura a punho do termo de ciência das três ocorrências.\n\nA confirmação da ciência será registrada após a assinatura presencial.\nAtenciosamente,\nSecretaria Municipal de Educação de Carbonita.';
  end if;
  return jsonb_build_object('student',jsonb_build_object('id',s.id,'name',s.nome,'school',school_name,'contacts',s."contatosResponsaveis"),
    'summary',jsonb_build_object('studentId',s.id,'cycleId',coalesce(current_cycle.id,''),'cycleNumber',coalesce(current_cycle.numero,next_number),
      'count',coalesce(current_cycle.contador,0),'pending',coalesce(current_cycle.status='PENDENTE_ASSINATURA',false)),
    'cycles',cycles,'message',message_text);
end $$;

create or replace function public.rotas_student_features(action text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.usuarios; s public.estudantes; cycle public.advertencia_ciclos; previous public.advertencias;
  request_id uuid; reason text; signed_name text; n integer; result jsonb;
begin
  u:=private.actor();
  if action='warningHistory' then return private.warning_history(u,payload->>'studentId'); end if;
  if action not in ('addWarning','resetWarningCycle') then raise exception 'Ação de advertência inválida.'; end if;
  perform 1 from public.estudantes where id=payload->>'studentId' for update;
  s:=private.feature_student(u,payload->>'studentId',action='addWarning');
  if action='addWarning' then
    reason:=private.clean(payload->>'reason',800,true);
    begin request_id:=(payload->>'requestId')::uuid;
    exception when invalid_text_representation then raise exception 'Identificador de envio inválido. Reabra o formulário.'; end;
    if request_id is null then raise exception 'Identificador de envio ausente. Reabra o formulário.'; end if;
    select * into previous from public.advertencias where "requestId"=request_id;
    if previous.id is not null then
      if previous."estudanteId"<>s.id or previous."usuarioId"<>u.id or previous.motivo<>reason then raise exception 'Este identificador já foi usado em outra ocorrência.'; end if;
      return private.warning_history(u,s.id)||jsonb_build_object('duplicate',true);
    end if;
    select * into cycle from public.advertencia_ciclos where "estudanteId"=s.id and status<>'ENCERRADO' for update;
    if cycle.id is null then
      select coalesce(max(numero),0)+1 into n from public.advertencia_ciclos where "estudanteId"=s.id;
      insert into public.advertencia_ciclos("estudanteId",numero) values(s.id,n) returning * into cycle;
    end if;
    if coalesce((payload->>'cycleNumber')::integer,0)<>cycle.numero then raise exception 'O ciclo foi atualizado em outro acesso. Reabra o histórico antes de registrar.'; end if;
    if cycle.contador>=3 then raise exception 'Este estudante está pendente de assinatura. Confirme a assinatura presencial antes de iniciar outro ciclo.'; end if;
    n:=cycle.contador+1;
    insert into public.advertencias("cicloId","estudanteId","escolaId","rotaId",numero,motivo,"usuarioId","requestId")
      values(cycle.id,s.id,s."escolaId",private.main_route(s."rotaId"),n,reason,u.id,request_id);
    update public.advertencia_ciclos set contador=n,status=case when n=3 then 'PENDENTE_ASSINATURA' else 'ABERTO' end where id=cycle.id;
    perform private.audit(u,'REGISTRAR_ADVERTENCIA','estudantes',s.id,'Ciclo '||cycle.numero||' · '||n||'/3');
  else
    if u.perfil not in ('secretaria','monitor') then raise exception 'A confirmação da assinatura deve ser feita por Monitor ou Secretaria.' using errcode='42501'; end if;
    select * into cycle from public.advertencia_ciclos where id=payload->>'cycleId' and "estudanteId"=s.id for update;
    if cycle.id is null then raise exception 'Ciclo não encontrado. Atualize o histórico.'; end if;
    if cycle.status='ENCERRADO' then return private.warning_history(u,s.id)||jsonb_build_object('duplicate',true); end if;
    if cycle.contador<>3 or cycle.status<>'PENDENTE_ASSINATURA' then raise exception 'A assinatura encerra somente um ciclo com três advertências.'; end if;
    if payload->>'signed' is distinct from 'true' then raise exception 'Confirme que a assinatura a punho foi realizada presencialmente.'; end if;
    signed_name:=private.clean(payload->>'signerName',140,true);
    update public.advertencia_ciclos set status='ENCERRADO',"assinadoEm"=now(),"assinadoPor"=u.id,"nomeAssinante"=signed_name where id=cycle.id;
    perform private.audit(u,'CONFIRMAR_ASSINATURA_ADVERTENCIAS','estudantes',s.id,'Ciclo '||cycle.numero);
  end if;
  update public.sync_state set revision=revision+1 where id=1;
  return private.warning_history(u,s.id)||jsonb_build_object('duplicate',false);
end $$;
revoke all on function public.rotas_student_features(text,jsonb) from public,anon;
grant execute on function public.rotas_student_features(text,jsonb) to authenticated;

-- Atualizações das funções de cadastro e leitura, conservando os demais fluxos.
create or replace function private.save(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare typ text:=p->>'type'; item jsonb:=p->'item'; k text:=coalesce(nullif(p#>>'{item,id}',''),gen_random_uuid()::text);
  y text:=coalesce(nullif(item->>'ano',''),p->>'year',left(private.today()::text,4));
  t text; old jsonb; j jsonb; fields text[]; r public.rotas; previous public.rotas; ids text[]; sc text; pt text;
begin
  if item is null or jsonb_typeof(item)<>'object' then raise exception 'Informe um cadastro.'; end if;
  t:=case typ when 'school' then 'escolas' when 'class' then 'turmas' when 'route' then 'rotas' when 'stop' then 'pontos' when 'student' then 'estudantes' end;
  if t is null then raise exception 'Tipo de cadastro inválido.'; end if;
  execute format('select to_jsonb(v) from public.%I v where id=$1 for update',t) into old using k;
  item:=item-array['ativo','criadoEm','qrToken','crachaCodigo','crachaAnteriores','rotaVinculadaEm'];
  j:=coalesce(old,'{}')||item||jsonb_build_object('id',k);
  foreach sc in array array['escolaId','turmaId','rotaId','pontoId'] loop
    if j->>sc='' then j:=jsonb_set(j,array[sc],'null'); end if;
  end loop;
  if typ='student' and u.perfil='monitor' then
    if old is null or not (old->>'ativo')::boolean then raise exception 'Estudante ativo não encontrado.'; end if;
    r:=private.transport_route(u,item->>'rotaId',old->>'ano');
    if coalesce(old->>'rotaId','')<>'' then
      previous:=private.transport_route(u,old->>'rotaId',old->>'ano');
      if not (old->>'escolaId'=any(previous."escolaIds")) then raise exception 'A rota atual não atende à escola do estudante.'; end if;
    end if;
    if not (old->>'escolaId'=any(r."escolaIds")) then raise exception 'A rota não atende à escola do estudante.'; end if;
    pt:=nullif(item->>'pontoId','');
    if not (pt is null and old->>'pontoId' is null and private.main_route(old->>'rotaId')=r.id)
      and not exists(select 1 from public.pontos where id=pt and private.main_route("rotaId")=r.id and (ativo or id=old->>'pontoId')) then raise exception 'Selecione um ponto válido da rota.'; end if;
    j:=j||private.student_feature_fields(item,false);
    update public.estudantes set "rotaId"=r.id,"pontoId"=pt,
      "rotaVinculadaEm"=case when private.main_route("rotaId") is distinct from r.id then now() else "rotaVinculadaEm" end,
      turnos=array(select jsonb_array_elements_text(j->'turnos')),"contatosResponsaveis"=j->'contatosResponsaveis',responsavel=j->>'responsavel',celular=j->>'celular' where id=k;
    perform private.audit(u,'VINCULAR_ROTA_PONTO','estudantes',k);
    return jsonb_build_object('id',k);
  end if;
  if u.perfil not in ('secretaria','escola') then raise exception 'Ação não permitida para este perfil.' using errcode='42501'; end if;
  if typ='school' then
    if u.perfil<>'secretaria' then raise exception 'Apenas a Secretaria pode gerenciar escolas.'; end if;
    fields:=array['nome','endereco','telefone'];
  elsif typ='class' then
    if u.perfil='escola' and (j->>'escolaId' is distinct from u."escolaId" or (old is not null and old->>'escolaId' is distinct from u."escolaId")) then raise exception 'Turma de outra escola.' using errcode='42501'; end if;
    j:=j||jsonb_build_object('ano',y); fields:=array['nome','ano','escolaId','turno'];
  elsif typ='route' then
    if old is not null then select * into previous from public.rotas where id=k;
      if not private.edit_route(u,previous) then raise exception 'Apenas a Secretaria pode editar rotas compartilhadas.'; end if;
      y:=previous.ano;
    end if;
    if u.perfil='escola' then ids:=array[u."escolaId"];
    elsif jsonb_typeof(item->'escolaIds')='array' then select array_agg(distinct v) into ids from jsonb_array_elements_text(item->'escolaIds') v;
    elsif old is not null then ids:=previous."escolaIds";
    else ids:=array[nullif(item->>'escolaId','')]; end if;
    if coalesce(cardinality(ids),0)=0 or exists(select 1 from unnest(ids) i where i is null or not exists(select 1 from public.escolas where id=i and ativo)) then raise exception 'Selecione escolas ativas para a rota.'; end if;
    if exists(select 1 from public.estudantes s where s.ativo and private.main_route(s."rotaId")=k and not (s."escolaId"=any(ids))) then raise exception 'Uma escola retirada ainda tem estudantes nesta rota.'; end if;
    if exists(select 1 from public.rotas v where v.ano=y and v.ativo and v."rotaPrincipalId" is null and v.id<>k and private.name_key(v.nome)=private.name_key(j->>'nome')) then raise exception 'Já existe uma rota com este nome no ano letivo.'; end if;
    j:=j||jsonb_build_object('ano',y,'escolaId',ids[1],'escolaIds',ids);
    fields:=array['nome','ano','escolaId','escolaIds','motorista','veiculo'];
  elsif typ='stop' then
    select * into r from public.rotas where id=private.main_route(j->>'rotaId');
    if not coalesce(private.edit_route(u,r),false) then raise exception 'Selecione uma rota que seu perfil pode gerenciar.'; end if;
    if old is not null then
      select * into previous from public.rotas where id=private.main_route(old->>'rotaId');
      if not coalesce(private.edit_route(u,previous),false) then raise exception 'Ponto de uma rota sem permissão de edição.'; end if;
      if previous.id<>r.id and exists(select 1 from public.estudantes where ativo and "pontoId"=k) then raise exception 'O ponto tem estudantes ativos vinculados.'; end if;
    end if;
    j:=j||jsonb_build_object('rotaId',r.id,'ordem',coalesce(nullif(j->>'ordem','')::int,1));
    fields:=array['nome','rotaId','ordem','horarioEstimado'];
  elsif typ='student' then
    j:=j||private.student_feature_fields(item,old is null);
    if old is not null and old->>'escolaId' is distinct from j->>'escolaId' and not (item ? 'turmaId') then j:=jsonb_set(j,'{turmaId}','null'); end if;
    if u.perfil='escola' and (j->>'escolaId' is distinct from u."escolaId" or (old is not null and old->>'escolaId' is distinct from u."escolaId")) then raise exception 'Estudante de outra escola.' using errcode='42501'; end if;
    if not exists(select 1 from public.escolas where id=j->>'escolaId' and ativo) then raise exception 'Selecione uma escola ativa.'; end if;
    if j->>'turmaId' is not null and not exists(select 1 from public.turmas where id=j->>'turmaId' and ano=y and "escolaId"=j->>'escolaId') then raise exception 'Turma incompatível com a escola e o ano letivo.'; end if;
    if j->>'rotaId' is not null then
      select * into r from public.rotas where id=private.main_route(j->>'rotaId');
      if r.id is null or r.ano<>y or not (j->>'escolaId'=any(r."escolaIds")) or (not r.ativo and private.main_route(old->>'rotaId') is distinct from r.id) then raise exception 'Selecione uma rota do ano letivo que atenda à escola.'; end if;
      j:=j||jsonb_build_object('rotaId',r.id);
    end if;
    if j->>'pontoId' is not null and not exists(select 1 from public.pontos where id=j->>'pontoId' and private.main_route("rotaId")=r.id and (ativo or id=old->>'pontoId')) then raise exception 'Selecione um ponto válido da rota escolhida.'; end if;
    if old is null or private.main_route(old->>'rotaId') is distinct from r.id or old->>'escolaId' is distinct from j->>'escolaId' or old->>'ano' is distinct from y then
      j:=j||jsonb_build_object('rotaVinculadaEm',case when r.id is not null then now() else null end);
    end if;
    if old is null or old->>'crachaCodigo' is null then j:=j||jsonb_build_object('crachaCodigo',private.new_badge(k)); end if;
    j:=j||jsonb_build_object('ano',y);
    fields:=array['nome','ano','escolaId','turmaId','rotaId','pontoId','responsavel','celular','logradouro','crachaCodigo','rotaVinculadaEm','turnos','contatosResponsaveis'];
  end if;
  if j ? 'nome' then j:=jsonb_set(j,'{nome}',to_jsonb(private.clean(j->>'nome',140,true))); end if;
  foreach sc in array array['logradouro','endereco','responsavel','celular','telefone','motorista','veiculo','turno','horarioEstimado'] loop
    if j ? sc then j:=jsonb_set(j,array[sc],to_jsonb(private.clean(j->>sc,case when sc in ('logradouro','endereco') then 200 else 140 end))); end if;
  end loop;
  perform private.save_row(t,j,fields);
  perform private.audit(u,case when old is null then 'CRIAR' else 'EDITAR' end,t,k);
  return jsonb_build_object('id',k);
end $$;

create or replace function private.snapshot(u public.usuarios,p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare y text; d date; routes text[]; schools text[]; students text[]; result jsonb; revision bigint;
begin
  select a.ano into y from public.anos a order by
    (a.ano=coalesce(p->>'year','')) desc,(a.ano=left(private.today()::text,4) and a.ativo) desc,a.ativo desc,a.ano desc limit 1;
  y:=coalesce(y,left(private.today()::text,4));
  d:=coalesce(nullif(p->>'day','')::date,private.today());
  select coalesce(array_agg(r.id),'{}') into routes from public.rotas r where r.ano=y and r."rotaPrincipalId" is null and
    (u.perfil='secretaria' or (u.perfil='escola' and u."escolaId"=any(r."escolaIds")) or
      (u.perfil='monitor' and r.ativo and exists(select 1 from public.atribuicoes a where a."usuarioId"=u.id and a.ano=y and private.main_route(a."rotaId")=r.id)));
  select coalesce(array_agg(s.id),'{}') into schools from public.escolas s where
    u.perfil='secretaria' or (u.perfil='escola' and s.id=u."escolaId") or
    (u.perfil='monitor' and exists(select 1 from public.rotas r where r.id=any(routes) and s.id=any(r."escolaIds")));
  select coalesce(array_agg(s.id),'{}') into students from public.estudantes s where s.ano=y and
    (u.perfil='secretaria' or (u.perfil='escola' and s."escolaId"=u."escolaId") or
      (u.perfil='monitor' and s.ativo and ((private.main_route(s."rotaId")=any(routes) and exists(select 1 from public.rotas vr where vr.id=private.main_route(s."rotaId") and s."escolaId"=any(vr."escolaIds")))
        or (s."rotaId" is null and s."escolaId"=any(schools)))));
  select s.revision into revision from public.sync_state s where id=1;
  result:=jsonb_build_object('version',revision::text,'user',private.public_user(u),'year',y,'day',d,
    'years',(select coalesce(jsonb_agg(ano order by ano),'[]') from public.anos),
    'schools',(select coalesce(jsonb_agg(to_jsonb(s) order by s.nome),'[]') from public.escolas s where id=any(schools)),
    'classes',(select coalesce(jsonb_agg(to_jsonb(c) order by c.nome),'[]') from public.turmas c where c.ano=y and c."escolaId"=any(schools)),
    'routes',(select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('escolaIds',case when u.perfil='escola' then array[u."escolaId"] else r."escolaIds" end,
      'escolaId',case when u.perfil='escola' then u."escolaId" else r."escolaId" end,'compartilhada',cardinality(r."escolaIds")>1) order by r.nome),'[]') from public.rotas r where r.id=any(routes)),
    'stops',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('rotaId',private.main_route(t."rotaId")) order by t.ordem,t.nome),'[]') from public.pontos t where private.main_route(t."rotaId")=any(routes)),
    'students',(select coalesce(jsonb_agg((to_jsonb(s)-'crachaAnteriores')||jsonb_build_object('rotaId',coalesce(private.main_route(s."rotaId"),'')) ||
      case when u.perfil='monitor' then jsonb_build_object('qrToken',null,'logradouro',null,'celular',case when s."rotaId" is null then '' else s.celular end,'contatosResponsaveis',case when s."rotaId" is null then '[]'::jsonb else s."contatosResponsaveis" end) else '{}'::jsonb end order by s.nome),'[]') from public.estudantes s where s.id=any(students)),
    'calls',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('dia',c.data,'registradoEm',c."criadoEm",'rotaId',private.main_route(c."rotaId"))),'[]') from public.chamadas c where c.data=d
      and (u.perfil='secretaria' or (u.perfil='escola' and c."escolaId"=u."escolaId" and c."estudanteId"=any(students)) or (u.perfil='monitor' and private.main_route(c."rotaId")=any(routes) and c."estudanteId"=any(students)))),
    'assignments',case when u.perfil='secretaria' then (select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('rotaId',private.main_route(a."rotaId"))),'[]') from public.atribuicoes a where ano=y) else '[]'::jsonb end);
  if u.perfil='secretaria' then
    result:=result||jsonb_build_object('users',(select coalesce(jsonb_agg(private.public_user(v) order by v.nome),'[]') from public.usuarios v),
      'audit',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('data',a."dataHora")),'[]') from (select * from public.auditoria order by "dataHora" desc limit 80) a));
  end if;
  if u.perfil in ('secretaria','monitor') then
    result:=result||jsonb_build_object('absenceAlerts',private.absence_alerts(y,routes),
      'closedDays',(with latest as (
        select distinct on (private.main_route(t."rotaId"),sc,t.data) private.main_route(t."rotaId") route_id,t.data,sc,t.encerrado
        from public.dias_rota t cross join lateral unnest(t."escolaIds") sc
        where private.main_route(t."rotaId")=any(routes) and t.data in (d,private.today())
        order by private.main_route(t."rotaId"),sc,t.data,t."atualizadoEm" desc,t.id desc
      ), closed as (select l.route_id,l.data from latest l join public.rotas r on r.id=l.route_id
        where l.sc=any(r."escolaIds") group by l.route_id,l.data having bool_and(l.encerrado) and count(distinct l.sc)=(select cardinality(r2."escolaIds") from public.rotas r2 where r2.id=l.route_id))
      select coalesce(jsonb_agg(jsonb_build_object('routeId',route_id,'day',data)),'[]') from closed));
  end if;
  result:=result||jsonb_build_object('studentFeaturesVersion',1,'warningSummaries',(
    select coalesce(jsonb_agg(jsonb_build_object('studentId',s.id,'cycleId',coalesce(c.id,''),
      'cycleNumber',coalesce(c.numero,(select coalesce(max(numero),0)+1 from public.advertencia_ciclos where "estudanteId"=s.id)),
      'count',coalesce(c.contador,0),'pending',coalesce(c.status='PENDENTE_ASSINATURA',false))),'[]')
    from public.estudantes s left join public.advertencia_ciclos c on c."estudanteId"=s.id and c.status<>'ENCERRADO'
    where s.id=any(students) and (u.perfil<>'monitor' or s."rotaId" is not null)));
  return result;
end $$;


revoke all on all functions in schema private from public,anon,authenticated,service_role;
update public.sync_state set revision=revision+1 where id=1;
commit;
select 'Turnos, contatos e advertências atualizados. Recarregue o aplicativo.' as resultado;
