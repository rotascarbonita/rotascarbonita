begin;
create function private.save_row(t text,j jsonb,allowed text[]) returns void language plpgsql set search_path = '' as $$
declare cols text; changes text;
begin
  select string_agg(format('%I',k),','),string_agg(format('%1$I=excluded.%1$I',k),',')
    into cols,changes from jsonb_object_keys(j) k where k=any(allowed) and k<>'id';
  if cols is null then raise exception 'Nenhum campo informado.'; end if;
  execute format('insert into public.%1$I(id,%2$s) select id,%2$s from jsonb_populate_record(null::public.%1$I,$1) on conflict(id) do update set %3$s',t,cols,changes) using j;
end $$;
create function private.clean(v text,max_len int,required boolean default false) returns text language plpgsql immutable set search_path = '' as $$
declare x text:=regexp_replace(trim(coalesce(v,'')),'\s+',' ','g');
begin
  if length(x)>max_len or x ~ '^[=]' or x ~ '[\x00-\x1f\x7f]' or (required and x='') then
    raise exception 'Informe texto válido com até % caracteres.',max_len;
  end if;
  return x;
end $$;

create function private.save(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
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
    if not exists(select 1 from public.pontos where id=item->>'pontoId' and private.main_route("rotaId")=r.id and (ativo or id=old->>'pontoId')) then raise exception 'Selecione um ponto válido da rota.'; end if;
    update public.estudantes set "rotaId"=r.id,"pontoId"=item->>'pontoId',
      "rotaVinculadaEm"=case when private.main_route("rotaId") is distinct from r.id then now() else "rotaVinculadaEm" end where id=k;
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
    fields:=array['nome','ano','escolaId','turmaId','rotaId','pontoId','responsavel','celular','logradouro','crachaCodigo','rotaVinculadaEm'];
  end if;
  if j ? 'nome' then j:=jsonb_set(j,'{nome}',to_jsonb(private.clean(j->>'nome',140,true))); end if;
  foreach sc in array array['logradouro','endereco','responsavel','celular','telefone','motorista','veiculo','turno','horarioEstimado'] loop
    if j ? sc then j:=jsonb_set(j,array[sc],to_jsonb(private.clean(j->>sc,case when sc in ('logradouro','endereco') then 200 else 140 end))); end if;
  end loop;
  perform private.save_row(t,j,fields);
  perform private.audit(u,case when old is null then 'CRIAR' else 'EDITAR' end,t,k);
  return jsonb_build_object('id',k);
end $$;

create function private.attendance(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare d date:=(p->>'day')::date; direction text:=coalesce(p->>'sentido','IDA'); qr text:=trim(coalesce(p->>'qr',''));
  code text; v_status text; origin text; r public.rotas; s public.estudantes; c public.chamadas; duplicate boolean:=false;
begin
  if d is null or d>private.today() or direction not in ('IDA','VOLTA') then raise exception 'Selecione uma data válida, até hoje, e o sentido da viagem.'; end if;
  r:=private.transport_route(u,p->>'routeId',left(d::text,4));
  v_status:=case when qr<>'' then 'PRESENTE' else coalesce(p->>'status','PRESENTE') end;
  origin:=case when qr='' then 'MANUAL' when p->>'typed'='true' then 'CODIGO' else 'QR' end;
  if v_status not in ('PRESENTE','AUSENTE') then raise exception 'Status de chamada inválido.'; end if;
  if qr<>'' and d<>private.today() then raise exception 'A leitura do crachá registra embarques na data de hoje.'; end if;
  if origin='CODIGO' then
    code:=regexp_replace(upper(qr),'[\s-]','','g');
    if code !~ '^RC[2-9A-HJ-NP-Z]{8}$' then raise exception 'Código de crachá inválido.'; end if;
    code:='RC-'||substr(code,3,4)||'-'||substr(code,7,4);
  elsif qr<>'' and (left(qr,3)<>'TC:' or length(qr) not between 4 and 200) then raise exception 'Este QR não é um crachá do Rotas Carbonita.'; end if;
  select * into s from public.estudantes where ativo and
    case when code is not null then "crachaCodigo"=code when qr<>'' then "qrToken"=substr(qr,4) else id=p->>'studentId' end for share;
  if s.id is null then raise exception 'Crachá ou estudante ativo não encontrado.'; end if;
  if private.main_route(s."rotaId") is distinct from r.id or s.ano<>r.ano or not (s."escolaId"=any(r."escolaIds")) then raise exception 'Este estudante não pertence à rota selecionada.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.id||':'||d::text||':'||direction,0));
  select * into c from public.chamadas where data=d and sentido=direction and "estudanteId"=s.id for update;
  if c.id is not null and (qr='' or private.main_route(c."rotaId")<>r.id or c."escolaId"<>s."escolaId") then raise exception 'Já existe uma chamada para este estudante no mesmo dia e sentido.'; end if;
  duplicate:=c.id is not null and (c.origem='QR' or c.origem=origin);
  if not duplicate then
    insert into public.chamadas(id,data,sentido,"estudanteId","rotaId","pontoId","escolaId",status,"usuarioId",origem)
      values(coalesce(c.id,gen_random_uuid()::text),d,direction,s.id,r.id,s."pontoId",s."escolaId",v_status,u.id,origin)
      on conflict(data,sentido,"estudanteId") do update set status=excluded.status,"usuarioId"=excluded."usuarioId","criadoEm"=now(),origem=excluded.origem returning * into c;
    perform private.audit(u,case when origin='QR' then 'CHECK_IN_QR' else 'CHAMADA' end,'chamadas',c.id,direction||' · '||v_status);
  end if;
  return jsonb_build_object('id',c.id,'status',c.status,'studentName',s.nome,'badgeCode',s."crachaCodigo",'schoolId',s."escolaId",
    'sentido',direction,'registradoEm',c."criadoEm",'duplicate',duplicate,'call',to_jsonb(c)||jsonb_build_object('dia',c.data,'registradoEm',c."criadoEm",'rotaId',r.id));
end $$;

create function private.disable(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare typ text:=p->>'type'; k text:=p->>'id'; t text; target jsonb; r public.rotas; linked boolean;
begin
  if u.perfil='monitor' then raise exception 'Ação não permitida para monitor.'; end if;
  t:=case typ when 'school' then 'escolas' when 'class' then 'turmas' when 'route' then 'rotas' when 'stop' then 'pontos' when 'student' then 'estudantes' when 'user' then 'usuarios' end;
  if t is null then raise exception 'Tipo inválido.'; end if;
  execute format('select to_jsonb(v) from public.%I v where id=$1 for update',t) into target using k;
  if target is null or not (target->>'ativo')::boolean then raise exception 'Registro inexistente ou já desativado.'; end if;
  if typ in ('school','user') and u.perfil<>'secretaria' then raise exception 'Apenas a Secretaria pode desativar este cadastro.'; end if;
  if typ in ('route','stop') then
    select * into r from public.rotas where id=private.main_route(case when typ='route' then k else target->>'rotaId' end);
    if not private.edit_route(u,r) or (typ='route' and target->>'rotaPrincipalId' is not null) then raise exception 'Cadastro sem permissão de edição.'; end if;
  elsif u.perfil='escola' and target->>'escolaId' is distinct from u."escolaId" then raise exception 'Registro de outra escola.'; end if;
  select exists(select 1 from public.estudantes s where s.ativo and case typ
    when 'school' then s."escolaId"=k when 'class' then s."turmaId"=k when 'route' then private.main_route(s."rotaId")=k when 'stop' then s."pontoId"=k else false end) into linked;
  if linked then raise exception 'O cadastro possui estudantes ativos vinculados.'; end if;
  if typ='user' and k=u.id then raise exception 'Não é possível desativar seu próprio acesso.'; end if;
  execute format('update public.%I set ativo=false where id=$1',t) using k;
  perform private.audit(u,'DESATIVAR',t,k);
  return '{"success":true}'::jsonb;
end $$;

create function private.merge_routes(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare a public.rotas; b public.rotas; ids text[];
begin
  if u.perfil<>'secretaria' then raise exception 'Apenas a Secretaria pode unificar rotas.'; end if;
  select * into a from public.rotas where id=p->>'primaryId' for update;
  select * into b from public.rotas where id=p->>'secondaryId' for update;
  if a.id is null or b.id is null or a.id=b.id or not a.ativo or not b.ativo or a.ano<>b.ano or a."rotaPrincipalId" is not null then raise exception 'Selecione duas rotas ativas do mesmo ano.'; end if;
  if b."rotaPrincipalId"=a.id then return jsonb_build_object('id',a.id); end if;
  if b."rotaPrincipalId" is not null then raise exception 'A outra rota já foi unificada.'; end if;
  select array_agg(distinct i) into ids from unnest(a."escolaIds"||b."escolaIds") i;
  update public.rotas set "escolaIds"=ids,"escolaId"=ids[1],motorista=coalesce(nullif(a.motorista,''),b.motorista),veiculo=coalesce(nullif(a.veiculo,''),b.veiculo) where id=a.id;
  update public.rotas set "rotaPrincipalId"=a.id where id=b.id or "rotaPrincipalId"=b.id;
  -- Vínculos históricos permanecem na origem; main_route resolve a rota atual.
  perform private.audit(u,'UNIFICAR','rotas',a.id,b.id);
  return jsonb_build_object('id',a.id);
end $$;

create function private.assign(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare ids text[]; k text:=p->>'userId'; y text:=p->>'year';
begin
  if u.perfil<>'secretaria' then raise exception 'Apenas a Secretaria pode atribuir rotas.'; end if;
  if jsonb_typeof(p->'routeIds') is distinct from 'array' then raise exception 'Selecione as rotas do monitor.'; end if;
  select coalesce(array_agg(distinct private.main_route(v)),'{}') into ids from jsonb_array_elements_text(p->'routeIds') v;
  if cardinality(ids)>2 then raise exception 'Selecione até duas rotas por monitor.'; end if;
  if not exists(select 1 from public.usuarios where id=k and ativo and perfil='monitor') then raise exception 'Selecione um monitor ativo.'; end if;
  if not exists(select 1 from public.anos where ano=y) or exists(select 1 from unnest(ids) i where not exists(select 1 from public.rotas where id=i and ativo and ano=y and "rotaPrincipalId" is null)) then raise exception 'Selecione rotas ativas do ano letivo.'; end if;
  delete from public.atribuicoes where "usuarioId"=k and ano=y;
  insert into public.atribuicoes("usuarioId",ano,"rotaId") select k,y,i from unnest(ids) i;
  perform private.audit(u,'ATRIBUIR_ROTAS','atribuicoes',k);
  return '{"success":true}'::jsonb;
end $$;
commit;
