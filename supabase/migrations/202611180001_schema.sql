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
