begin;
select pg_advisory_xact_lock(hashtextextended('rotas:catalog',0));
do $migration$
declare
  src text;
  anchor text;
  guard constant text := $body$if typ='student' and u.perfil='monitor' then
    if old is null and nullif(item->>'id','') is not null then
      raise exception 'Estudante não disponível para este acesso.' using errcode='42501';
    end if;
    if old is not null then
      if not (old->>'ativo')::boolean or y is distinct from old->>'ano' then
        raise exception 'Estudante não disponível neste ano letivo.' using errcode='42501';
      end if;
      if old->>'rotaId' is not null then
        previous:=private.transport_route(u,old->>'rotaId',old->>'ano');
        if not (old->>'escolaId'=any(previous."escolaIds")) or (old->>'pontoId' is not null
          and not exists(select 1 from public.pontos p where p.id=old->>'pontoId' and private.main_route(p."rotaId")=previous.id)) then
          raise exception 'Escola ou ponto fora da rota atual.' using errcode='42501';
        end if;
      end if;
    end if;
    r:=private.transport_route(u,j->>'rotaId',y);
    if j->>'escolaId' is null or not (j->>'escolaId'=any(r."escolaIds")) then
      raise exception 'A rota não atende à escola do estudante.' using errcode='42501';
    end if;
    if j->>'pontoId' is null and (old is null or previous.id is distinct from r.id or old->>'pontoId' is not null) then
      raise exception 'Selecione um ponto de embarque da rota.';
    end if;
    if old is not null and old->>'rotaId' is null then
      if j->>'escolaId' is distinct from old->>'escolaId' then
        raise exception 'Vincule o estudante à rota da escola atual.' using errcode='42501';
      end if;
      item:=jsonb_build_object('rotaId',j->>'rotaId','pontoId',j->>'pontoId');
      j:=old||item;
    end if;
  end if;
  if typ='student' and u.perfil='monitor' and old is not null and old->>'rotaId' is null then$body$;
  mask constant text := $body$when u.perfil='monitor' and s."rotaId" is null then$body$;
  badge_guard constant text := $body$      if u.perfil='monitor' then
        r:=private.transport_route(u,s."rotaId",s.ano);
        if not (s."escolaId"=any(r."escolaIds")) or (s."pontoId" is not null
          and not exists(select 1 from public.pontos p where p.id=s."pontoId" and private.main_route(p."rotaId")=r.id)) then
          raise exception 'Estudante fora das escolas da rota.' using errcode='42501';
        end if;
      end if;
$body$;
begin
  src:=pg_get_functiondef('private.save(public.usuarios,jsonb)'::regprocedure);
  if strpos(src,guard)=0 then
    anchor:=$body$if typ='student' and u.perfil='monitor' then$body$;
    if strpos(src,anchor)=0 or strpos(src,$body$if u.perfil not in ('secretaria','escola') then$body$)=0 then
      raise exception 'Versão do cadastro incompatível.';
    end if;
    execute replace(replace(src,anchor,guard),
      $body$if u.perfil not in ('secretaria','escola') then$body$,
      $body$if u.perfil not in ('secretaria','escola') and not (u.perfil='monitor' and typ='student') then$body$);
  end if;

  src:=pg_get_functiondef('private.snapshot(public.usuarios,jsonb)'::regprocedure);
  if strpos(src,mask||$body$ array['nomeMae','nomePai']$body$)=0 then
    if strpos(src,$body$when u.perfil='monitor' then array['nomeMae','nomePai']$body$)=0
      or strpos(src,$body$when u.perfil='monitor' then jsonb_build_object('qrToken',null$body$)=0 then
      raise exception 'Execute primeiro ATUALIZAR_CRACHAS_E_MONITORAS.sql.';
    end if;
    execute replace(replace(src,$body$when u.perfil='monitor' then array['nomeMae','nomePai']$body$,
      mask||$body$ array['nomeMae','nomePai']$body$),
      $body$when u.perfil='monitor' then jsonb_build_object('qrToken',null$body$,
      mask||$body$ jsonb_build_object('qrToken',null$body$);
    src:=pg_get_functiondef('private.snapshot(public.usuarios,jsonb)'::regprocedure);
    if strpos(src,'return result;')=0 then raise exception 'Versão da função de leitura incompatível.'; end if;
    execute replace(src,'return result;', $body$return result||jsonb_build_object('studentFeatures',
      to_regprocedure('private.student_feature_fields(jsonb,boolean)') is not null);$body$);
  end if;

  src:=pg_get_functiondef('public.rotas_api(text,jsonb)'::regprocedure);
  if strpos(src,badge_guard)=0 then
    anchor:=$body$      if s."crachaCodigo" is distinct from payload->>'currentCode' then$body$;
    if strpos(src,anchor)=0 or strpos(src,$body$Apenas Secretaria e Escola podem substituir um crachá.$body$)=0 then
      raise exception 'Versão da função de crachá incompatível.';
    end if;
    execute replace(replace(src,
      $body$if u.perfil not in ('secretaria','escola') then raise exception 'Apenas Secretaria e Escola podem substituir um crachá.'; end if;$body$,
      $body$if u.perfil not in ('secretaria','escola','monitor') then raise exception 'Ação não permitida para este perfil.'; end if;$body$),
      anchor,badge_guard||anchor);
  end if;
end $migration$;
update public.sync_state set revision=revision+1 where id=1;
commit;
