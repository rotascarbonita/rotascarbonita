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
