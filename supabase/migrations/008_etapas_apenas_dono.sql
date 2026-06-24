-- =============================================================================
-- ZapFlow — Gestão de etapas restrita ao DONO da empresa
-- =============================================================================
-- Até a 006, qualquer usuário autenticado da empresa (atendente inclusive) podia
-- inserir/editar/excluir etapas do funil. Agora SÓ o dono (perfis.papel='dono')
-- pode modificar a estrutura do funil; atendentes seguem com SELECT (operam o
-- funil, mas não alteram colunas).
--
-- A leitura (SELECT) NÃO muda. Só INSERT/UPDATE/DELETE ganham a trava de dono.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Helper: o usuário logado é DONO da própria empresa?
-- ----------------------------------------------------------------------------
-- Mesmo padrão das demais (SECURITY DEFINER + search_path fixo) para ler perfis
-- ignorando o RLS e evitar recursão de policy. Retorna false para atendente,
-- superadmin (não tem papel 'dono'), anônimo ou sem perfil.
create or replace function public.sou_dono_da_empresa()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select papel = 'dono' from public.perfis where id = auth.uid()),
    false
  );
$$;

grant execute on function public.sou_dono_da_empresa() to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Policies de escrita de etapas: superadmin OU (mesma empresa E dono)
-- ----------------------------------------------------------------------------
-- SELECT (etapas_select da 006) permanece inalterada: qualquer um da empresa
-- (e superadmin) continua lendo o funil.

drop policy if exists etapas_insert on public.etapas;
create policy etapas_insert on public.etapas
  for insert to authenticated
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists etapas_update on public.etapas;
create policy etapas_update on public.etapas
  for update to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  )
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists etapas_delete on public.etapas;
create policy etapas_delete on public.etapas
  for delete to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

-- ----------------------------------------------------------------------------
-- 3. GRANTs (idempotente) — mantém o acesso do service_role ao provisionamento.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.etapas to authenticated;
grant select, insert, update, delete on public.etapas to service_role;
