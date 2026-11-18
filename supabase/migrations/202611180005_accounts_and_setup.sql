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
