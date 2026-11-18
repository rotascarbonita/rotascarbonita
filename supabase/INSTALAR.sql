-- ROTAS CARBONITA: instale UMA VEZ em um projeto novo.

-- Rotas Carbonita: dados relacionais e acesso exclusivamente por RPC autenticada.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.anos (
  ano text primary key check (ano ~ '^20[0-9]{2}$'),
  ativo boolean not null default true, "criadoEm" timestamptz not null default now()
);
create table public.escolas (
  id text primary key default gen_random_uuid()::text,
  nome text not null check (length(trim(nome)) between 1 and 140),
  endereco text not null default '', telefone text not null default '',
  ativo boolean not null default true, "criadoEm" timestamptz not null default now()
);
create table public.turmas (
  id text primary key default gen_random_uuid()::text,
  ano text not null references public.anos, "escolaId" text not null references public.escolas,
  nome text not null, turno text not null default '',
  ativo boolean not null default true, "criadoEm" timestamptz not null default now()
);
create table public.rotas (
  id text primary key default gen_random_uuid()::text,
  ano text not null references public.anos, "escolaId" text not null references public.escolas,
  "escolaIds" text[] not null check (cardinality("escolaIds") > 0),
  nome text not null check (length(trim(nome)) between 1 and 140),
  motorista text not null default '', veiculo text not null default '',
  "rotaPrincipalId" text references public.rotas,
  ativo boolean not null default true, "criadoEm" timestamptz not null default now(),
  check ("rotaPrincipalId" is null or "rotaPrincipalId" <> id),
  check ("escolaId" = "escolaIds"[1])
);
create table public.pontos (
  id text primary key default gen_random_uuid()::text, "rotaId" text not null references public.rotas,
  nome text not null, ordem integer not null default 1 check (ordem >= 0),
  "horarioEstimado" text not null default '', ativo boolean not null default true,
  "criadoEm" timestamptz not null default now()
);
create table public.usuarios (
  id text primary key default gen_random_uuid()::text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  nome text not null, login text not null unique check (login ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  perfil text not null check (perfil in ('secretaria','escola','monitor')),
  "escolaId" text references public.escolas,
  "exigeTroca" boolean not null default true, ativo boolean not null default true,
  "criadoEm" timestamptz not null default now(),
  check (perfil <> 'escola' or "escolaId" is not null)
);
create table private.password_guards (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  password_checkpoint text not null
);
create table public.estudantes (
  id text primary key default gen_random_uuid()::text, ano text not null references public.anos,
  "escolaId" text not null references public.escolas, "turmaId" text references public.turmas,
  "rotaId" text references public.rotas, "pontoId" text references public.pontos,
  nome text not null check (length(trim(nome)) between 1 and 140),
  responsavel text not null default '', celular text not null default '', logradouro text not null default '',
  "qrToken" text not null unique default gen_random_uuid()::text,
  "crachaCodigo" text unique, "crachaAnteriores" text[] not null default '{}',
  "rotaVinculadaEm" timestamptz, ativo boolean not null default true,
  "criadoEm" timestamptz not null default now()
);
-- Códigos aposentados também ficam reservados, para nunca serem reutilizados.
create table private.badge_registry (code text primary key, student_id text not null);
create table public.atribuicoes (
  id text primary key default gen_random_uuid()::text, "usuarioId" text not null references public.usuarios,
  ano text not null references public.anos, "rotaId" text not null references public.rotas,
  "criadoEm" timestamptz not null default now(), unique ("usuarioId", ano, "rotaId")
);
create table public.chamadas (
  id text primary key default gen_random_uuid()::text, data date not null,
  sentido text not null check (sentido in ('IDA','VOLTA')),
  "estudanteId" text not null references public.estudantes, "rotaId" text not null references public.rotas,
  "pontoId" text references public.pontos, "escolaId" text not null references public.escolas,
  status text not null check (status in ('PRESENTE','AUSENTE')),
  "usuarioId" text references public.usuarios, "criadoEm" timestamptz not null default now(),
  origem text not null check (origem in ('QR','CODIGO','MANUAL')),
  unique (data, sentido, "estudanteId")
);
create table public.dias_rota (
  id text primary key default gen_random_uuid()::text, ano text not null references public.anos,
  "rotaId" text not null references public.rotas, data date not null, encerrado boolean not null,
  "usuarioId" text references public.usuarios, "atualizadoEm" timestamptz not null default now(),
  "escolaIds" text[] not null
);
create table public.motivos_ausencia (
  id text primary key default gen_random_uuid()::text, ano text not null references public.anos,
  "rotaId" text not null references public.rotas, "estudanteId" text not null references public.estudantes,
  inicio date not null, fim date not null, dias integer not null check (dias >= 3),
  motivo text not null check (length(motivo) between 1 and 500),
  "usuarioId" text references public.usuarios, "registradoEm" timestamptz not null default now(),
  unique ("rotaId", "estudanteId", inicio)
);
create table public.auditoria (
  id text primary key default gen_random_uuid()::text, "dataHora" timestamptz not null default now(),
  acao text not null, entidade text not null, "entidadeId" text not null default '',
  "usuarioId" text references public.usuarios, detalhes text not null default ''
);
create table public.sync_state (
  id integer primary key check (id = 1), revision bigint not null default 1
);
insert into public.sync_state(id) values (1);

create index on public.rotas (ano) where "rotaPrincipalId" is null;
create index on public.rotas using gin ("escolaIds");
create index on public.estudantes (ano,"escolaId");
create index on public.estudantes ("rotaId",ativo);
create index on public.estudantes ("pontoId");
create index on public.pontos ("rotaId",ordem);
create index on public.turmas (ano,"escolaId");
create index on public.atribuicoes ("usuarioId",ano);
create index on public.chamadas ("rotaId",data);
create index on public.chamadas ("estudanteId",data);
create index on public.dias_rota ("rotaId",data,"atualizadoEm" desc);
create index on public.auditoria ("dataHora" desc);

-- Fail closed: nenhuma tabela de dados tem política de leitura/gravação direta.
-- O único ponto de acesso é rotas_api, com verificação de perfil em cada ação.
do $$ declare t text; begin
  foreach t in array array['anos','escolas','turmas','rotas','pontos','usuarios','estudantes',
    'atribuicoes','chamadas','dias_rota','motivos_ausencia','auditoria','sync_state'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
  end loop;
end $$;
revoke all on all tables in schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
commit;


begin;
create function private.name_key(v text) returns text language sql immutable set search_path = '' as $$
  select lower(translate(regexp_replace(trim(coalesce(v,'')), '\s+', ' ', 'g'),
    'áàâãäÁÀÂÃÄéèêëÉÈÊËíìîïÍÌÎÏóòôõöÓÒÔÕÖúùûüÚÙÛÜçÇ',
    'aaaaaAAAAAeeeeEEEEiiiiIIIIoooooOOOOOuuuuUUUUcC'));
$$;
create function private.today() returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;
create function private.main_route(p_id text) returns text language sql stable set search_path = '' as $$
  select coalesce((select "rotaPrincipalId" from public.rotas where id=p_id),p_id);
$$;
create function private.public_user(u public.usuarios) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id',u.id,'nome',u.nome,'login',u.login,'perfil',u.perfil,
    'escolaId',coalesce(u."escolaId",''),'ativo',case when u.ativo then 'SIM' else 'NAO' end,
    'exigeTroca',u."exigeTroca",'trocarSenha',case when u."exigeTroca" then 'SIM' else 'NAO' end);
$$;
create function private.actor(allow_password_change boolean default false) returns public.usuarios
language plpgsql stable set search_path = '' as $$
declare u public.usuarios;
begin
  select * into u from public.usuarios where auth_user_id=auth.uid();
  if u.id is null or not u.ativo then raise exception 'Sessão inválida ou usuário inativo.' using errcode='42501'; end if;
  if u."exigeTroca" and not allow_password_change then raise exception 'Inicialização exige troca de senha obrigatória.' using errcode='42501'; end if;
  return u;
end $$;
create function private.audit(u public.usuarios, a text, t text, k text, d text default '') returns void
language sql set search_path = '' as $$
  insert into public.auditoria(acao,entidade,"entidadeId","usuarioId",detalhes)
    values(a,t,coalesce(k,''),u.id,coalesce(d,''));
$$;
create function private.edit_route(u public.usuarios,r public.rotas) returns boolean
language sql stable set search_path = '' as $$
  select r.id is not null and r."rotaPrincipalId" is null and (u.perfil='secretaria' or
    (u.perfil='escola' and cardinality(r."escolaIds")=1 and u."escolaId"=any(r."escolaIds")));
$$;
create function private.transport_route(u public.usuarios,k text,y text) returns public.rotas
language plpgsql stable set search_path = '' as $$
declare r public.rotas;
begin
  if u.perfil not in ('secretaria','monitor') then raise exception 'Apenas Monitor e Secretaria podem registrar o transporte.'; end if;
  select * into r from public.rotas where id=private.main_route(k) and ano=y and ativo and "rotaPrincipalId" is null;
  if r.id is null then raise exception 'Selecione uma rota ativa do ano letivo da chamada.'; end if;
  if u.perfil='monitor' and not exists(select 1 from public.atribuicoes a where a."usuarioId"=u.id
    and a.ano=y and private.main_route(a."rotaId")=r.id) then raise exception 'Monitor não autorizado para esta rota.' using errcode='42501'; end if;
  return r;
end $$;
create function private.new_badge(student_id text) returns text language plpgsql set search_path = '' as $$
declare n bigint; v text; c text; i int; tries int; inserted int;
begin
  for tries in 1..100 loop
    n:=('x'||substr(replace(gen_random_uuid()::text,'-',''),1,10))::bit(40)::bigint; v:='';
    for i in 1..8 loop v:=substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ',(n%32)::int+1,1)||v; n:=n/32; end loop;
    c:='RC-'||substr(v,1,4)||'-'||substr(v,5,4);
    insert into private.badge_registry(code,student_id) values(c,student_id) on conflict do nothing;
    get diagnostics inserted=row_count;
    if inserted=1 then return c; end if;
  end loop;
  raise exception 'Não foi possível gerar o crachá. Tente novamente.';
end $$;

create function private.absence_alerts(y text, route_ids text[]) returns jsonb
language sql stable set search_path = '' as $$
  with latest as (
    select distinct on (private.main_route(d."rotaId"),sc,d.data)
      private.main_route(d."rotaId") route_id,sc school_id,d.data service_day,d.encerrado closed,d."atualizadoEm" updated
    from public.dias_rota d cross join lateral unnest(d."escolaIds") sc
    where d.ano=y and private.main_route(d."rotaId")=any(route_ids) and d.data<=private.today()
    order by private.main_route(d."rotaId"),sc,d.data,d."atualizadoEm" desc,d.id desc
  ), timeline as (
    select route_id,school_id,service_day,closed,updated from latest
    union all
    select distinct private.main_route(c."rotaId"),c."escolaId",c.data,false,null::timestamptz
    from public.chamadas c where private.main_route(c."rotaId")=any(route_ids)
      and c.data::text like y||'-%' and c.data<=private.today()
      and not exists(select 1 from latest l where l.route_id=private.main_route(c."rotaId") and l.school_id=c."escolaId" and l.service_day=c.data)
  ), student_days as (
    select s.id,s.nome,s."escolaId",private.main_route(s."rotaId") route_id,t.service_day,
      (t.closed and not exists(select 1 from public.chamadas c where c."estudanteId"=s.id and c.data=t.service_day and c.status='PRESENTE')) absent
    from public.estudantes s join timeline t on t.route_id=private.main_route(s."rotaId") and t.school_id=s."escolaId"
    where s.ano=y and s.ativo and t.service_day>=((coalesce(s."rotaVinculadaEm",s."criadoEm")) at time zone 'America/Sao_Paulo')::date
      and (not t.closed or t.updated>=coalesce(s."rotaVinculadaEm",s."criadoEm"))
  ), islands as (
    select *,sum(case when absent then 0 else 1 end) over(partition by id,route_id order by service_day) grp from student_days
  ), streaks as (
    select id,nome,"escolaId",route_id,min(service_day) inicio,max(service_day) fim,count(*) dias from islands
    where absent group by id,nome,"escolaId",route_id,grp having count(*)>=3
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id',jsonb_build_array(s.id,s.route_id,s.inicio::text)::text,'estudanteId',s.id,'nome',s.nome,
    'rotaId',s.route_id,'escolaId',s."escolaId",'inicio',s.inicio,'fim',s.fim,'dias',s.dias,
    'motivo',coalesce(m.motivo,''),'revisao',coalesce(to_jsonb(m."registradoEm")#>>'{}',''))
    order by s.fim desc,s.nome),'[]'::jsonb)
  from streaks s left join lateral (select reason.* from public.motivos_ausencia reason
    where reason."estudanteId"=s.id and private.main_route(reason."rotaId")=s.route_id and reason.inicio=s.inicio
    order by reason."registradoEm" desc,reason.id desc limit 1) m on true;
$$;

create function private.snapshot(u public.usuarios,p jsonb) returns jsonb
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
      case when u.perfil='monitor' then jsonb_build_object('qrToken',null,'logradouro',null,'celular',case when s."rotaId" is null then '' else s.celular end) else '{}'::jsonb end order by s.nome),'[]') from public.estudantes s where s.id=any(students)),
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
  return result;
end $$;

create function public.rotas_can_sync() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.usuarios where auth_user_id=auth.uid() and ativo and not "exigeTroca");
$$;
revoke all on function public.rotas_can_sync() from public,anon;
grant execute on function public.rotas_can_sync() to authenticated;
grant select on public.sync_state to authenticated;
create policy sync_read on public.sync_state for select to authenticated using ((select public.rotas_can_sync()));
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.sync_state;
  end if;
end $$;
commit;


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


begin;
create function private.import_students(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare sc text:=p->>'escolaId'; y text:=p->>'year'; row_data jsonb; parsed jsonb:='[]'; changes jsonb:='[]'; issues jsonb:='[]';
  seen text[]:='{}'; new_names text[]:='{}'; shared_names text[]:='{}';
  counts jsonb:='{"created":0,"updated":0,"existing":0,"repeated":0,"review":0}';
  n text; street text; bairro text; nk text; rk text; reason text; s public.estudantes; r public.rotas;
  line_no int:=1; n_students int; n_routes int; candidates text[]; confirmation text; result jsonb;
  fill_address boolean; key text; version bigint; target_id text; student_id text;
begin
  if u.perfil not in ('secretaria','escola') or (u.perfil='escola' and sc is distinct from u."escolaId") then raise exception 'Importe somente para uma escola autorizada.' using errcode='42501'; end if;
  if not exists(select 1 from public.escolas where id=sc and ativo) or not exists(select 1 from public.anos where ano=y) then raise exception 'Selecione escola ativa e ano letivo cadastrado.'; end if;
  if jsonb_typeof(p->'rows') is distinct from 'array' then raise exception 'Envie uma planilha de estudantes.'; end if;
  if jsonb_array_length(p->'rows') not between 1 and 2000 then raise exception 'Envie entre 1 e 2.000 linhas.'; end if;
  for row_data in select value from jsonb_array_elements(p->'rows') loop
    line_no:=line_no+1;
    n:=regexp_replace(trim(coalesce(row_data->>'nome','')),'\s+',' ','g');
    street:=regexp_replace(trim(coalesce(row_data->>'logradouro','')),'\s+',' ','g');
    bairro:=regexp_replace(trim(coalesce(row_data->>'bairro','')),'\s+',' ','g');
    reason:='';
    if row_data->>'formula'='true' or n ~ '^=' or street ~ '^=' or bairro ~ '^=' then reason:='Cole os valores da linha como texto.';
    elsif length(n) not between 1 and 140 or private.name_key(n) in ('-','nao informado') then reason:='Informe um nome em texto com até 140 caracteres.';
    elsif length(street) not between 1 and 200 or private.name_key(street) in ('-','nao informado') then reason:='Informe o logradouro em texto com até 200 caracteres.';
    elsif length(bairro) not between 1 and 140 or private.name_key(bairro) in ('-','nao informado') then reason:='Informe o bairro da rota em texto com até 140 caracteres.'; end if;
    if reason<>'' then issues:=issues||jsonb_build_array(jsonb_build_object('line',line_no,'nome',left(n,140),'reason',reason));
    else parsed:=parsed||jsonb_build_array(jsonb_build_object('line',line_no,'nome',n,'logradouro',street,'bairro',bairro,'nameKey',private.name_key(n),'routeKey',private.name_key(bairro))); end if;
  end loop;
  for row_data in select value from jsonb_array_elements(parsed) loop
    nk:=row_data->>'nameKey'; rk:=row_data->>'routeKey'; reason:=''; s:=null; r:=null;
    if exists(select 1 from jsonb_array_elements(parsed) q where q->>'nameKey'=nk and
      (private.name_key(q->>'logradouro')<>private.name_key(row_data->>'logradouro') or q->>'routeKey'<>rk)) then reason:='Mesmo nome com endereços ou rotas diferentes na planilha.';
    elsif nk=any(seen) then counts:=jsonb_set(counts,'{repeated}',to_jsonb((counts->>'repeated')::int+1)); continue; end if;
    seen:=array_append(seen,nk);
    select count(*) into n_students from public.estudantes where "escolaId"=sc and ano=y and private.name_key(nome)=nk;
    select * into s from public.estudantes where "escolaId"=sc and ano=y and private.name_key(nome)=nk limit 1;
    select array_agg(distinct private.main_route(v.id)) into candidates from public.rotas v where v.ano=y and private.name_key(v.nome)=rk;
    select count(*) into n_routes from public.rotas where id=any(candidates) and ativo;
    select * into r from public.rotas where id=any(candidates) and ativo limit 1;
    fill_address:=s.id is null or private.name_key(s.logradouro) in ('','-','nao informado');
    if reason='' then
      if n_students>1 then reason:='Há mais de um cadastro com esse nome nesta escola e ano.';
      elsif s.id is not null and not s.ativo then reason:='O cadastro do estudante está inativo.';
      elsif n_routes>1 then reason:='Há mais de uma rota ativa com esse bairro. Revise os cadastros.';
      elsif r.id is null and coalesce(cardinality(candidates),0)>0 then reason:='A rota desse bairro está inativa.';
      elsif r.id is not null and not (sc=any(r."escolaIds")) and u.perfil='escola' then reason:='Peça à Secretaria para vincular sua escola à rota cadastrada.';
      elsif s."rotaId" is not null and private.main_route(s."rotaId") is distinct from r.id then reason:='O estudante já tem outra rota.';
      elsif s."rotaId" is null and s."pontoId" is not null then reason:='Confira o ponto de embarque já cadastrado.';
      elsif not fill_address and private.name_key(s.logradouro)<>private.name_key(row_data->>'logradouro') then reason:='O cadastro tem outro logradouro.'; end if;
    end if;
    if reason<>'' then issues:=issues||jsonb_build_array(jsonb_build_object('line',row_data->'line','nome',row_data->>'nome','reason',reason)); continue; end if;
    if s."rotaId" is not null and not fill_address and sc=any(r."escolaIds") then counts:=jsonb_set(counts,'{existing}',to_jsonb((counts->>'existing')::int+1)); continue; end if;
    if r.id is null and not (row_data->>'bairro'=any(new_names)) then new_names:=array_append(new_names,row_data->>'bairro'); end if;
    if r.id is not null and not (sc=any(r."escolaIds")) and not (r.nome=any(shared_names)) then shared_names:=array_append(shared_names,r.nome); end if;
    key:=case when s.id is null then 'created' else 'updated' end;
    counts:=jsonb_set(counts,array[key],to_jsonb((counts->>key)::int+1));
    changes:=changes||jsonb_build_array(jsonb_build_object('row',row_data,'studentId',s.id,'routeId',r.id,'fillAddress',fill_address));
  end loop;
  counts:=jsonb_set(counts,'{review}',to_jsonb(jsonb_array_length(issues)));
  select revision into version from public.sync_state where id=1;
  confirmation:=md5(jsonb_build_array(u.id,sc,y,counts,changes,issues,new_names,shared_names,version)::text);
  result:=jsonb_build_object('counts',counts,'issues',issues,'routes',new_names,'sharedRoutes',shared_names,'confirmation',confirmation,'saved',false,
    'needsReview',coalesce(p->>'confirmation','')<>'' and p->>'confirmation'<>confirmation);
  if p->>'confirmation' is distinct from confirmation or jsonb_array_length(changes)=0 then return result; end if;
  for row_data in select value from jsonb_array_elements(changes) loop
    target_id:=row_data->>'routeId';
    if target_id is null then
      select id into target_id from public.rotas where ano=y and "rotaPrincipalId" is null and ativo and private.name_key(nome)=row_data#>>'{row,routeKey}' limit 1;
      if target_id is null then
        insert into public.rotas(ano,"escolaId","escolaIds",nome) values(y,sc,array[sc],row_data#>>'{row,bairro}') returning id into target_id;
      end if;
    end if;
    update public.rotas set "escolaIds"=array_append("escolaIds",sc) where id=target_id and not (sc=any("escolaIds"));
    student_id:=row_data->>'studentId';
    if student_id is null then
      student_id:=gen_random_uuid()::text;
      insert into public.estudantes(id,ano,"escolaId",nome,logradouro,"rotaId","rotaVinculadaEm","crachaCodigo")
        values(student_id,y,sc,row_data#>>'{row,nome}',row_data#>>'{row,logradouro}',target_id,now(),private.new_badge(student_id));
    else
      update public.estudantes set logradouro=case when (row_data->>'fillAddress')::boolean then row_data#>>'{row,logradouro}' else logradouro end,
        "rotaVinculadaEm"=case when private.main_route("rotaId") is distinct from target_id then now() else "rotaVinculadaEm" end,"rotaId"=target_id where id=student_id;
    end if;
  end loop;
  perform private.audit(u,'IMPORTAR','estudantes',sc,counts::text);
  return result||'{"saved":true,"needsReview":false}'::jsonb;
end $$;

create function public.rotas_api(action text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u public.usuarios; result jsonb; r public.rotas; s public.estudantes; k text; d date; code text;
  alert jsonb; rev text; checkpoint text; current_hash text;
begin
  u:=private.actor(action in ('me','completePasswordChange'));
  if action='me' then return private.public_user(u); end if;
  if action='completePasswordChange' then
    select g.password_checkpoint into checkpoint from private.password_guards g where g.auth_user_id=u.auth_user_id;
    select a.encrypted_password into current_hash from auth.users a where a.id=u.auth_user_id;
    if u."exigeTroca" and (checkpoint is null or checkpoint='PENDING' or checkpoint=current_hash) then raise exception 'Altere sua senha antes de continuar.'; end if;
    update public.usuarios set "exigeTroca"=false where id=u.id returning * into u;
    delete from private.password_guards where auth_user_id=u.auth_user_id;
    perform private.audit(u,'ALTERAR_SENHA','usuarios',u.id);
    update public.sync_state set revision=revision+1 where id=1;
    return jsonb_build_object('success',true,'user',private.public_user(u));
  end if;
  if action='snapshot' then return private.snapshot(u,payload); end if;
  if action='updates' then
    select revision::text into rev from public.sync_state where id=1;
    if payload->>'version'=rev then return jsonb_build_object('changed',false,'version',rev); end if;
    return private.snapshot(u,payload)||'{"changed":true}'::jsonb;
  end if;
  -- Só alterações de catálogo compartilham lock; embarques usam locks por aluno/dia/sentido.
  if action in ('save','disable','mergeRoutes','setAssignments','importStudents','createYear','replaceBadge','setupMonitors') then
    perform pg_advisory_xact_lock(hashtextextended('rotas:catalog',0));
  end if;
  case action
    when 'save' then result:=private.save(u,payload);
    when 'disable' then result:=private.disable(u,payload);
    when 'mergeRoutes' then result:=private.merge_routes(u,payload);
    when 'setAssignments' then result:=private.assign(u,payload);
    when 'attendance' then result:=private.attendance(u,payload);
    when 'importStudents' then
      result:=private.import_students(u,payload);
      if not (result->>'saved')::boolean then return result; end if;
    when 'replaceBadge' then
      if u.perfil not in ('secretaria','escola') then raise exception 'Apenas Secretaria e Escola podem substituir um crachá.'; end if;
      select * into s from public.estudantes where id=payload->>'studentId' and ativo for update;
      if s.id is null or (u.perfil='escola' and s."escolaId" is distinct from u."escolaId") then raise exception 'Estudante não disponível para este acesso.'; end if;
      if s."crachaCodigo" is distinct from payload->>'currentCode' then raise exception 'O crachá foi atualizado. Atualize os dados antes de substituir.'; end if;
      code:=private.new_badge(s.id);
      update public.estudantes set "crachaAnteriores"=array_append("crachaAnteriores",s."crachaCodigo"),"crachaCodigo"=code,"qrToken"=gen_random_uuid()::text where id=s.id returning * into s;
      perform private.audit(u,'SUBSTITUIR_CRACHA','estudantes',s.id);
      result:=jsonb_build_object('id',s.id,'crachaCodigo',s."crachaCodigo",'qrToken',s."qrToken");
    when 'setRouteDay' then
      d:=(payload->>'day')::date;
      if d is null or d>private.today() or jsonb_typeof(payload->'closed') is distinct from 'boolean' then raise exception 'Informe uma data válida e se deseja encerrar o dia.'; end if;
      r:=private.transport_route(u,payload->>'routeId',left(d::text,4));
      perform pg_advisory_xact_lock(hashtextextended(r.id||':'||d::text,0));
      insert into public.dias_rota(ano,"rotaId",data,encerrado,"usuarioId","escolaIds") values(r.ano,r.id,d,(payload->>'closed')::boolean,u.id,r."escolaIds") returning id into k;
      perform private.audit(u,case when (payload->>'closed')::boolean then 'ENCERRAR_DIA' else 'REABRIR_DIA' end,'dias_rota',k,d::text);
      result:=jsonb_build_object('closed',(payload->>'closed')::boolean);
    when 'saveAbsence' then
      d:=(payload->>'start')::date;
      r:=private.transport_route(u,payload->>'routeId',left(d::text,4));
      perform pg_advisory_xact_lock(hashtextextended('absence:'||coalesce(payload->>'studentId','')||':'||d::text,0));
      select v into alert from jsonb_array_elements(private.absence_alerts(r.ano,array[r.id])) v where v->>'estudanteId'=payload->>'studentId' and v->>'inicio'=d::text;
      if alert is null then raise exception 'Este alerta mudou. Atualize as ausências.'; end if;
      if alert->>'revisao' is distinct from coalesce(payload->>'revision','') then raise exception 'O motivo foi atualizado em outro acesso. Reabra o alerta.'; end if;
      insert into public.motivos_ausencia(ano,"rotaId","estudanteId",inicio,fim,dias,motivo,"usuarioId")
        values(r.ano,r.id,payload->>'studentId',d,(alert->>'fim')::date,(alert->>'dias')::int,private.clean(payload->>'reason',500,true),u.id)
        on conflict("rotaId","estudanteId",inicio) do update set fim=excluded.fim,dias=excluded.dias,motivo=excluded.motivo,"usuarioId"=excluded."usuarioId","registradoEm"=clock_timestamp();
      perform private.audit(u,'MOTIVO_AUSENCIA','motivos_ausencia',payload->>'studentId',d::text);
      result:='{"success":true}';
    when 'createYear' then
      if u.perfil<>'secretaria' or coalesce(payload->>'year','') !~ '^20[0-9]{2}$' then raise exception 'Somente Secretaria pode criar um ano letivo válido.'; end if;
      insert into public.anos(ano) values(payload->>'year') on conflict do nothing;
      perform private.audit(u,'CRIAR_ANO','anos',payload->>'year');
      result:=jsonb_build_object('success',true,'year',payload->>'year');
    when 'monitorSetupPreview' then return private.monitor_preview(u,payload);
    when 'setupMonitors' then result:=private.setup_monitors(u,payload);
    else raise exception 'Ação não reconhecida: %',action;
  end case;
  if not coalesce((result->>'duplicate')::boolean,false) then update public.sync_state set revision=revision+1 where id=1; end if;
  return result;
end $$;
revoke all on function public.rotas_api(text,jsonb) from public, anon;
grant execute on function public.rotas_api(text,jsonb) to authenticated;
-- Helpers não fazem parte da API PostgREST.
revoke all on all functions in schema private from public,anon,authenticated;
grant all on all tables in schema public to service_role;
commit;


begin;
-- Funções chamadas apenas pela Edge Function com service_role. Nunca pelo navegador.
create function public.rotas_prepare_password_reset(actor_auth_id uuid,target_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.usuarios; t public.usuarios;
begin
  select * into a from public.usuarios where auth_user_id=actor_auth_id and ativo and not "exigeTroca" and perfil='secretaria';
  if a.id is null then raise exception 'Apenas Secretaria autenticada pode redefinir senhas.' using errcode='42501'; end if;
  select * into t from public.usuarios where id=target_id for update;
  if t.id is null or t.auth_user_id is null or t.id=a.id then raise exception 'Para sua própria conta use Alterar senha.'; end if;
  update public.usuarios set "exigeTroca"=true where id=t.id;
  insert into private.password_guards values(t.auth_user_id,'PENDING') on conflict(auth_user_id) do update set password_checkpoint='PENDING';
end $$;

create function public.rotas_manage_user(actor_auth_id uuid,item jsonb,linked_auth_id uuid,password_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.usuarios; old public.usuarios; t public.usuarios; k text:=coalesce(nullif(item->>'id',''),gen_random_uuid()::text);
  username text:=lower(trim(item->>'login')); role_name text:=item->>'perfil'; sc text; enabled boolean; hash text;
begin
  select * into a from public.usuarios where auth_user_id=actor_auth_id and ativo and not "exigeTroca" and perfil='secretaria';
  if a.id is null then raise exception 'Apenas Secretaria autenticada pode gerenciar acessos.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rotas:catalog',0));
  select * into old from public.usuarios where id=k for update;
  if username is null or username !~ '^[a-z0-9][a-z0-9._-]{2,79}$' or role_name not in ('secretaria','escola','monitor') then raise exception 'Informe login válido e perfil.'; end if;
  if old.id is not null and old.auth_user_id is not null and (old.auth_user_id<>linked_auth_id or old.login<>username) then raise exception 'O login de uma conta existente não pode ser alterado.'; end if;
  if old.id is null and not password_reset then raise exception 'Nova conta exige senha temporária.'; end if;
  sc:=case when role_name='escola' then nullif(item->>'escolaId','') else null end;
  if role_name='escola' and not exists(select 1 from public.escolas where id=sc and ativo) then raise exception 'Selecione uma escola ativa.'; end if;
  enabled:=case when item ? 'ativo' then item->>'ativo' not in ('NAO','false') else coalesce(old.ativo,true) end;
  if k=a.id and (not enabled or role_name<>'secretaria' or password_reset) then raise exception 'Não é possível remover ou redefinir seu próprio acesso.'; end if;
  if linked_auth_id is null or not exists(select 1 from auth.users where id=linked_auth_id and email=username||'@acesso.rotas.invalid') then raise exception 'Identidade de autenticação incompatível com o login.'; end if;
  insert into public.usuarios(id,auth_user_id,nome,login,perfil,"escolaId",ativo,"exigeTroca")
    values(k,linked_auth_id,private.clean(item->>'nome',140,true),username,role_name,sc,enabled,password_reset or coalesce(old."exigeTroca",true))
    on conflict(id) do update set auth_user_id=excluded.auth_user_id,nome=excluded.nome,perfil=excluded.perfil,"escolaId"=excluded."escolaId",ativo=excluded.ativo,"exigeTroca"=excluded."exigeTroca" returning * into t;
  if password_reset then
    select encrypted_password into hash from auth.users where id=linked_auth_id;
    insert into private.password_guards values(linked_auth_id,hash) on conflict(auth_user_id) do update set password_checkpoint=excluded.password_checkpoint;
  end if;
  perform private.audit(a,case when old.id is null then 'CRIAR_ACESSO' else 'EDITAR_ACESSO' end,'usuarios',k);
  update public.sync_state set revision=revision+1 where id=1;
  return jsonb_build_object('id',k);
end $$;

-- Vincula identidades após importar a planilha. Executável só com service_role.
create function public.rotas_link_imported_user(profile_id text,linked_auth_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.usuarios; hash text;
begin
  select * into p from public.usuarios where id=profile_id for update;
  if p.id is null or (p.auth_user_id is not null and p.auth_user_id<>linked_auth_id) then raise exception 'Perfil inexistente ou já vinculado a outra identidade.'; end if;
  select encrypted_password into hash from auth.users where id=linked_auth_id and email=p.login||'@acesso.rotas.invalid';
  if hash is null then raise exception 'Identidade incompatível.'; end if;
  update public.usuarios set auth_user_id=linked_auth_id,"exigeTroca"=true where id=profile_id;
  insert into private.password_guards values(linked_auth_id,hash) on conflict(auth_user_id) do update set password_checkpoint=excluded.password_checkpoint;
end $$;

revoke all on function public.rotas_prepare_password_reset(uuid,text),public.rotas_manage_user(uuid,jsonb,uuid,boolean),public.rotas_link_imported_user(text,uuid) from public,anon,authenticated;
grant execute on function public.rotas_prepare_password_reset(uuid,text),public.rotas_manage_user(uuid,jsonb,uuid,boolean),public.rotas_link_imported_user(text,uuid) to service_role;

create function private.monitor_definitions() returns jsonb language sql immutable set search_path = '' as $$
select '[{"key":"leites","nome":"Leites","monitors":[{"nome":"Elenice","login":"elenice"}],"stops":["Casa da Elenice","Depósito do Otacílio","Casa da Miriam","Dona Dica","Bar do Mussum","Bar do Agnaldo","Hospital","Igreja Matriz","Dona Cina","Pensão da Fiinha","EMEI"]},{"key":"simao","nome":"Simão","monitors":[{"nome":"Leticia","login":"leticia"},{"nome":"Carla","login":"carla"}],"stops":["Zezinho Noêmio","Construfort","Casas Populares","Oficina do Geraldo","Martelinho de Ouro","Mercearia da Paula","Zé Cabrito","Posto de Saúde","Tino Policarpo","Mestra Aurora"]}]'::jsonb;
$$;
create function private.monitor_preview(u public.usuarios,p jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare g jsonb; m jsonb; groups jsonb:='[]'; monitors jsonb; ids text[]; account public.usuarios;
begin
  if u.perfil<>'secretaria' or p->>'year' is distinct from '2026' then raise exception 'Configuração exclusiva da Secretaria para 2026.'; end if;
  for g in select value from jsonb_array_elements(private.monitor_definitions()) loop
    monitors:='[]';
    select array_agg(id) into ids from public.rotas where ativo and ano='2026' and "rotaPrincipalId" is null and regexp_replace(private.name_key(nome),'^rota\s+','')=private.name_key(g->>'nome');
    for m in select value from jsonb_array_elements(g->'monitors') loop
      select * into account from public.usuarios where login=m->>'login';
      if account.id is not null and (not account.ativo or account.perfil<>'monitor' or private.name_key(account.nome)<>private.name_key(m->>'nome')) then raise exception 'Login % pertence a outro cadastro ou está inativo.',m->>'login'; end if;
      monitors:=monitors||jsonb_build_array(m||jsonb_build_object('key',m->>'login','exists',account.id is not null));
    end loop;
    groups:=groups||jsonb_build_array(g||jsonb_build_object('routeId',case when cardinality(ids)=1 then ids[1] else '' end,'monitors',monitors));
  end loop;
  return jsonb_build_object('year','2026','groups',groups);
end $$;
create function private.setup_monitors(u public.usuarios,p jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare plan jsonb; g jsonb; m jsonb; stop_name text; idx int; r public.rotas; account public.usuarios;
  point public.pontos; matched int; assigned text[]; selected text[]:='{}';
  created int:=0; updated int:=0; assignments int:=0;
begin
  plan:=private.monitor_preview(u,p);
  for g in select value from jsonb_array_elements(plan->'groups') loop
    select * into r from public.rotas where id=private.main_route(p#>>array['routeIds',g->>'key']) and ativo and ano='2026';
    if r.id is null or r.id=any(selected) then raise exception 'Selecione duas rotas distintas, ativas, de 2026.'; end if;
    selected:=array_append(selected,r.id);
    for m in select value from jsonb_array_elements(g->'monitors') loop
      select * into account from public.usuarios where login=m->>'login' and ativo and perfil='monitor';
      if account.id is null or account.auth_user_id is null then raise exception 'Crie e vincule primeiro o acesso de %.',m->>'nome'; end if;
      select coalesce(array_agg(distinct private.main_route("rotaId")),'{}') into assigned from public.atribuicoes where "usuarioId"=account.id and ano='2026';
      if not (r.id=any(assigned)) then
        if cardinality(assigned)>=2 then raise exception '% já tem duas rotas.',account.nome; end if;
        insert into public.atribuicoes("usuarioId",ano,"rotaId") values(account.id,'2026',r.id); assignments:=assignments+1;
      end if;
    end loop;
    idx:=0;
    for stop_name in select jsonb_array_elements_text(g->'stops') loop
      idx:=idx+1;
      select count(*) into matched from public.pontos where private.main_route("rotaId")=r.id and private.name_key(nome)=private.name_key(stop_name);
      if matched>1 then raise exception 'Ponto % duplicado na rota.',stop_name; end if;
      select * into point from public.pontos where private.main_route("rotaId")=r.id and private.name_key(nome)=private.name_key(stop_name);
      if point.id is null then insert into public.pontos("rotaId",nome,ordem) values(r.id,stop_name,idx); created:=created+1;
      elsif point.nome<>stop_name or point.ordem<>idx or not point.ativo then
        update public.pontos set nome=stop_name,ordem=idx,ativo=true where id=point.id; updated:=updated+1;
      end if;
    end loop;
  end loop;
  perform private.audit(u,'CONFIGURAR_MONITORAS','atribuicoes','2026');
  return jsonb_build_object('success',true,'counts',jsonb_build_object('usersCreated',0,'stopsCreated',created,'stopsUpdated',updated,'assignmentsCreated',assignments));
end $$;
revoke all on all functions in schema private from public,anon,authenticated;
commit;
