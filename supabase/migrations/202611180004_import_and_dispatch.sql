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
