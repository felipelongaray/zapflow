-- =============================================================================
-- ZapFlow — Funil (Kanban) personalizável por empresa
-- =============================================================================
-- Cada empresa define as colunas (etapas) do seu funil. O contato passa a
-- referenciar uma etapa por FK (etapa_id). A coluna textual antiga `etapa`
-- (migration 001) é mantida por enquanto para não quebrar nada — será removida
-- numa migration futura depois da migração de dados.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tabela etapas (colunas do funil)
-- ----------------------------------------------------------------------------
create table public.etapas (
  id         uuid        primary key default gen_random_uuid(),
  empresa_id uuid        not null references public.empresas (id) on delete cascade,
  nome       text        not null,
  ordem      int         not null,
  created_at timestamptz not null default now()
);

create index etapas_empresa_id_idx on public.etapas (empresa_id);
-- Acelera a leitura do funil já ordenado por empresa.
create index etapas_empresa_ordem_idx on public.etapas (empresa_id, ordem);

-- ----------------------------------------------------------------------------
-- 2. contatos.etapa_id (nova FK para o funil)
-- ----------------------------------------------------------------------------
-- on delete set null: se a etapa for removida, o contato não some — apenas
-- fica "sem etapa" até ser reclassificado.
alter table public.contatos
  add column if not exists etapa_id uuid references public.etapas (id) on delete set null;

create index contatos_etapa_id_idx on public.contatos (etapa_id);

-- ----------------------------------------------------------------------------
-- 3. GRANTs
-- ----------------------------------------------------------------------------
-- authenticated: opera sob RLS (ver policies abaixo).
-- service_role: usado no provisionamento (criação de empresa). Mesmo ignorando
-- RLS, o service_role PRECISA do GRANT de tabela — foi exatamente o que faltava
-- e quebrou a criação de empresa antes.
grant select, insert, update, delete on public.etapas to authenticated;
grant select, insert, update, delete on public.etapas to service_role;

-- ----------------------------------------------------------------------------
-- 4. RLS (mesmo padrão multi-tenant das demais tabelas)
-- ----------------------------------------------------------------------------
alter table public.etapas enable row level security;

create policy etapas_select on public.etapas
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy etapas_insert on public.etapas
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy etapas_update on public.etapas
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

create policy etapas_delete on public.etapas
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- ----------------------------------------------------------------------------
-- 5. Função de provisionamento: etapas padrão
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER + search_path fixo (mesmo padrão das outras funções). Insere
-- o funil padrão de uma empresa. Como é DEFINER (ignora RLS), só deve ser
-- exposta ao backend de provisionamento: revogamos de public e concedemos
-- execute apenas ao service_role.
create or replace function public.criar_etapas_padrao(empresa_uuid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.etapas (empresa_id, nome, ordem)
  values
    (empresa_uuid, 'Novo', 0),
    (empresa_uuid, 'Em atendimento', 1),
    (empresa_uuid, 'Fechado', 2);
$$;

revoke all on function public.criar_etapas_padrao(uuid) from public;
grant execute on function public.criar_etapas_padrao(uuid) to service_role;
