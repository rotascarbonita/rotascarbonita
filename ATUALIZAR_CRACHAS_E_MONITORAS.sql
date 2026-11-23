-- Atualização para um banco Rotas Carbonita já instalado.
begin;
select pg_advisory_xact_lock(hashtextextended('rotas:catalog',0));

alter table public.estudantes
  add column if not exists "nomeMae" text not null default '',
  add column if not exists "nomePai" text not null default '';

-- Aplica o ajuste sobre a versão instalada, inclusive quando há turnos e advertências.
-- Se a estrutura conhecida não for encontrada, a transação inteira é revertida.
do $migration$
declare
  definition text;
  original text;
  save_fields constant text := $anchor$fields:=array['nome','ano','escolaId','turmaId','rotaId','pontoId','responsavel','celular','logradouro','crachaCodigo','rotaVinculadaEm'$anchor$;
  clean_fields constant text := $anchor$foreach sc in array array['logradouro','endereco','responsavel','celular','telefone','motorista','veiculo','turno','horarioEstimado']$anchor$;
  snapshot_fields constant text := $anchor$(to_jsonb(s)-'crachaAnteriores')$anchor$;
  safe_student_json constant text := $anchor$(to_jsonb(s)-'crachaAnteriores'-
    case when u.perfil='monitor' then array['nomeMae','nomePai'] else array[]::text[] end)$anchor$;
begin
  original := pg_get_functiondef('private.save(public.usuarios,jsonb)'::regprocedure);
  if strpos(original,save_fields||',''nomeMae'',''nomePai''')=0 then
    if strpos(original,save_fields)=0 or strpos(original,clean_fields)=0 then
      raise exception 'A função de cadastro instalada difere das versões previstas. Nenhuma alteração foi aplicada.';
    end if;
    definition := replace(original,save_fields,save_fields||',''nomeMae'',''nomePai''');
    definition := replace(definition,clean_fields,replace(clean_fields,']',',''nomeMae'',''nomePai'']'));
    execute definition;
  end if;

  original := pg_get_functiondef('private.snapshot(public.usuarios,jsonb)'::regprocedure);
  if strpos(original,safe_student_json)=0 and strpos(original,$anchor$array['nomeMae','nomePai']$anchor$)=0 then
    if strpos(original,snapshot_fields)=0 then
      raise exception 'A função de leitura instalada difere das versões previstas. Nenhuma alteração foi aplicada.';
    end if;
    execute replace(original,snapshot_fields,safe_student_json);
  end if;
end $migration$;

-- Reaproveita as identidades e rotas oficiais do cadastro operacional de 2026.
-- Cada conta recebe seu próprio vínculo e os demais vínculos ficam preservados.
do $assignments$
declare
  target record;
  account public.usuarios;
  route_id text;
  point_count integer;
  inserted integer;
begin
  if to_regclass('private.operational_route_groups') is null then
    raise warning 'Configuração operacional ausente. Aplique a configuração de Leites e Simão antes de vincular as monitoras.';
    return;
  end if;

  for target in
    select g.key,g.nome,g.route_id as configured_route,g.stops,m.value as monitor
    from private.operational_route_groups g
    cross join lateral jsonb_array_elements(g.monitores) m
    where g.ano='2026' and (g.key,m.value->>'login') in
      (('leites','elenice'),('simao','leticia'),('simao','carla'))
    order by g.key,m.value->>'login'
  loop
    select r.id into route_id from public.rotas r
    where r.id=private.main_route(target.configured_route) and r.ano='2026' and r.ativo;
    if route_id is null then
      raise warning '%: configure a rota % em Acessos > Configurar Leites e Simão.',target.monitor->>'nome',target.nome;
      continue;
    end if;

    insert into public.pontos ("rotaId",nome,ordem)
      select route_id,p.nome,p.ordem::integer
      from unnest(target.stops) with ordinality as p(nome,ordem)
      where not exists (
        select 1 from public.pontos existing
        where private.main_route(existing."rotaId")=route_id
          and private.name_key(existing.nome)=private.name_key(p.nome)
      );

    select u.* into account
    from public.usuarios u join auth.users a on a.id=u.auth_user_id
    where lower(a.email)=lower(target.monitor->>'email') and a.email_confirmed_at is not null
      and u.perfil='monitor' and u.ativo;
    if account.id is null then
      raise warning '%: vincule a conta confirmada a um perfil Monitor ativo em Acessos.',target.monitor->>'nome';
      continue;
    end if;

    insert into public.atribuicoes ("usuarioId",ano,"rotaId")
      select account.id,'2026',route_id where not exists (
        select 1 from public.atribuicoes a
        where a."usuarioId"=account.id and a.ano='2026' and private.main_route(a."rotaId")=route_id
      )
      on conflict ("usuarioId",ano,"rotaId") do nothing;
    get diagnostics inserted=row_count;
    if inserted>0 then
      insert into public.auditoria(acao,entidade,"entidadeId",detalhes)
      values ('VINCULAR_MONITOR_ROTA','usuarios',account.id,target.nome||' · 2026');
    end if;

    select count(*) into point_count from public.pontos p
      where p.ativo and private.main_route(p."rotaId")=route_id;
    if point_count=0 then
      raise warning '%: vínculo ativo em %, com pontos pendentes em Acessos > Configurar Leites e Simão.',target.monitor->>'nome',target.nome;
    else
      raise notice '%: vínculo ativo em %, com % ponto(s) ativo(s).',target.monitor->>'nome',target.nome,point_count;
    end if;
  end loop;
end $assignments$;

update public.sync_state set revision=revision+1 where id=1;
commit;
