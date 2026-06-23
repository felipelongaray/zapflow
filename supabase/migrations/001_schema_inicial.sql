-- =============================================================================
-- ZapFlow — Schema inicial (CRM de WhatsApp multi-tenant)
-- =============================================================================
-- Conceito de isolamento:
--   - Cada EMPRESA é um tenant.
--   - Cada PERFIL (usuário) pertence a no máximo uma empresa (empresa_id).
--   - O SUPERADMIN não pertence a nenhuma empresa (empresa_id NULL) e enxerga tudo.
--   - Todas as tabelas de negócio carregam empresa_id para permitir RLS por tenant.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manualmente.
-- =============================================================================

-- gen_random_uuid() vem da extensão pgcrypto (já disponível no Supabase, mas
-- garantimos que está habilitada).
create extension if not exists pgcrypto;

-- =============================================================================
-- 1. TABELAS
-- =============================================================================

-- ----------------------------------------------------------------------------
-- empresas (tenants)
-- ----------------------------------------------------------------------------
create table public.empresas (
  id           uuid        primary key default gen_random_uuid(),
  nome         text        not null,
  max_canais   int         not null default 1,
  max_usuarios int         not null default 2,
  status       text        not null default 'ativa' check (status in ('ativa', 'suspensa')),
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- perfis (estende auth.users)
--   id == auth.users.id (1:1). empresa_id NULL == superadmin (dono do sistema).
-- ----------------------------------------------------------------------------
create table public.perfis (
  id             uuid        primary key references auth.users (id) on delete cascade,
  empresa_id     uuid        references public.empresas (id) on delete cascade,
  nome           text,
  papel          text        not null default 'atendente' check (papel in ('dono', 'atendente')),
  is_super_admin boolean     not null default false,
  created_at     timestamptz not null default now()
);

create index perfis_empresa_id_idx on public.perfis (empresa_id);

-- ----------------------------------------------------------------------------
-- canais (números de WhatsApp)
-- ----------------------------------------------------------------------------
create table public.canais (
  id         uuid        primary key default gen_random_uuid(),
  empresa_id uuid        not null references public.empresas (id) on delete cascade,
  nome       text,
  numero     text,
  tipo       text        check (tipo in ('normal', 'business', 'api')),
  status     text        not null default 'desconectado',
  created_at timestamptz not null default now()
);

create index canais_empresa_id_idx on public.canais (empresa_id);

-- ----------------------------------------------------------------------------
-- contatos
-- ----------------------------------------------------------------------------
create table public.contatos (
  id         uuid        primary key default gen_random_uuid(),
  empresa_id uuid        not null references public.empresas (id) on delete cascade,
  canal_id   uuid        references public.canais (id) on delete set null,
  nome       text,
  telefone   text        not null,
  etapa      text        not null default 'novo',
  created_at timestamptz not null default now()
);

create index contatos_empresa_id_idx on public.contatos (empresa_id);
create index contatos_canal_id_idx on public.contatos (canal_id);

-- ----------------------------------------------------------------------------
-- conversas
-- ----------------------------------------------------------------------------
create table public.conversas (
  id           uuid        primary key default gen_random_uuid(),
  empresa_id   uuid        not null references public.empresas (id) on delete cascade,
  contato_id   uuid        references public.contatos (id) on delete cascade,
  canal_id     uuid        references public.canais (id) on delete set null,
  atendente_id uuid        references public.perfis (id) on delete set null,
  status       text        not null default 'aberta',
  created_at   timestamptz not null default now()
);

create index conversas_empresa_id_idx on public.conversas (empresa_id);
create index conversas_contato_id_idx on public.conversas (contato_id);
create index conversas_atendente_id_idx on public.conversas (atendente_id);

-- ----------------------------------------------------------------------------
-- mensagens
-- ----------------------------------------------------------------------------
create table public.mensagens (
  id          uuid        primary key default gen_random_uuid(),
  empresa_id  uuid        not null references public.empresas (id) on delete cascade,
  conversa_id uuid        not null references public.conversas (id) on delete cascade,
  conteudo    text,
  direcao     text        check (direcao in ('entrada', 'saida')),
  created_at  timestamptz not null default now()
);

create index mensagens_empresa_id_idx on public.mensagens (empresa_id);
create index mensagens_conversa_id_idx on public.mensagens (conversa_id);

-- =============================================================================
-- 2. FUNÇÕES HELPER (SECURITY DEFINER)
-- =============================================================================
-- IMPORTANTE: estas funções são SECURITY DEFINER para LER a tabela perfis
-- IGNORANDO o RLS. Se elas rodassem como o usuário (security invoker), a leitura
-- de perfis dispararia as próprias policies de perfis — que por sua vez chamam
-- estas funções — gerando RECURSÃO INFINITA. Rodando como o dono (definer),
-- a leitura de perfis não passa pelo RLS e a recursão é evitada.
--
-- search_path é fixado para evitar sequestro de schema (boa prática de segurança
-- obrigatória em funções SECURITY DEFINER).

-- Retorna o empresa_id do usuário logado (NULL para superadmin ou anônimo).
create or replace function public.get_minha_empresa()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select empresa_id
  from public.perfis
  where id = auth.uid();
$$;

-- Retorna true se o usuário logado for superadmin.
create or replace function public.sou_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_super_admin from public.perfis where id = auth.uid()),
    false
  );
$$;

-- =============================================================================
-- 3. GRANTS
-- =============================================================================
-- Sem GRANT o RLS não basta: o role authenticated precisa de permissão de tabela.
-- O RLS apenas FILTRA quais linhas são visíveis/alteráveis; o GRANT é o que
-- concede o direito de executar o comando em si.

grant usage on schema public to authenticated;

grant select, insert, update, delete on public.empresas  to authenticated;
grant select, insert, update, delete on public.perfis    to authenticated;
grant select, insert, update, delete on public.canais     to authenticated;
grant select, insert, update, delete on public.contatos   to authenticated;
grant select, insert, update, delete on public.conversas  to authenticated;
grant select, insert, update, delete on public.mensagens  to authenticated;

grant execute on function public.get_minha_empresa() to authenticated;
grant execute on function public.sou_super_admin() to authenticated;

-- =============================================================================
-- 4. RLS
-- =============================================================================
-- Habilita RLS em todas as tabelas. A partir daqui, sem policy explícita,
-- NENHUMA linha é acessível (default deny).

alter table public.empresas  enable row level security;
alter table public.perfis    enable row level security;
alter table public.canais    enable row level security;
alter table public.contatos  enable row level security;
alter table public.conversas enable row level security;
alter table public.mensagens enable row level security;

-- ----------------------------------------------------------------------------
-- empresas
--   - SELECT: usuário vê apenas a própria empresa; superadmin vê todas.
--   - INSERT/UPDATE/DELETE: somente superadmin gerencia empresas. Donos e
--     atendentes NÃO criam/editam/apagam empresas (decisão de produto: o tenant
--     é provisionado pelo dono do sistema).
-- ----------------------------------------------------------------------------
create policy empresas_select on public.empresas
  for select to authenticated
  using (
    public.sou_super_admin()
    or id = public.get_minha_empresa()
  );

create policy empresas_insert on public.empresas
  for insert to authenticated
  with check (public.sou_super_admin());

create policy empresas_update on public.empresas
  for update to authenticated
  using (public.sou_super_admin())
  with check (public.sou_super_admin());

create policy empresas_delete on public.empresas
  for delete to authenticated
  using (public.sou_super_admin());

-- ----------------------------------------------------------------------------
-- perfis
--   - SELECT: o próprio perfil + perfis da mesma empresa; superadmin vê todos.
--   - INSERT: superadmin pode inserir qualquer perfil. Usuário comum só pode
--     inserir um perfil dentro da própria empresa (id = auth.uid() garante que
--     ninguém crie perfil "para outra pessoa"; normalmente o INSERT é feito por
--     trigger/backend, mas deixamos a policy coerente).
--   - UPDATE: superadmin tudo; usuário comum só o próprio perfil.
--   - DELETE: somente superadmin (evita que um usuário se auto-remova ou remova
--     colegas; a remoção real costuma vir do cascade de auth.users).
-- ----------------------------------------------------------------------------
create policy perfis_select on public.perfis
  for select to authenticated
  using (
    public.sou_super_admin()
    or id = auth.uid()
    or empresa_id = public.get_minha_empresa()
  );

create policy perfis_insert on public.perfis
  for insert to authenticated
  with check (
    public.sou_super_admin()
    or (id = auth.uid() and empresa_id = public.get_minha_empresa())
  );

create policy perfis_update on public.perfis
  for update to authenticated
  using (
    public.sou_super_admin()
    or id = auth.uid()
  )
  with check (
    public.sou_super_admin()
    or id = auth.uid()
  );

create policy perfis_delete on public.perfis
  for delete to authenticated
  using (public.sou_super_admin());

-- ----------------------------------------------------------------------------
-- Tabelas de negócio (canais, contatos, conversas, mensagens)
--   Padrão único: superadmin faz tudo; usuário comum só opera dentro da própria
--   empresa (empresa_id = get_minha_empresa()), tanto na leitura (USING) quanto
--   na escrita (WITH CHECK, para impedir inserir/mover linha para outra empresa).
-- ----------------------------------------------------------------------------

-- canais
create policy canais_select on public.canais
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy canais_insert on public.canais
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy canais_update on public.canais
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy canais_delete on public.canais
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- contatos
create policy contatos_select on public.contatos
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy contatos_insert on public.contatos
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy contatos_update on public.contatos
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy contatos_delete on public.contatos
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- conversas
create policy conversas_select on public.conversas
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy conversas_insert on public.conversas
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy conversas_update on public.conversas
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy conversas_delete on public.conversas
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- mensagens
create policy mensagens_select on public.mensagens
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy mensagens_insert on public.mensagens
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy mensagens_update on public.mensagens
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy mensagens_delete on public.mensagens
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());
