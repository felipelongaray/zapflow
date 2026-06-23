-- =============================================================================
-- ZapFlow — Liberar o service_role nas triggers de proteção de perfis
-- =============================================================================
-- POR QUE ISTO É NECESSÁRIO:
-- As triggers de 002 (UPDATE) e 003 (INSERT) bloqueiam valores ELEVADOS
-- (papel='dono', is_super_admin=true, troca de empresa) para quem não é
-- superadmin. O problema: o service_role IGNORA RLS, mas NÃO ignora triggers.
-- E, ao usar o service_role no backend, não há usuário logado (auth.uid() é
-- NULL), então sou_super_admin() retorna false e a trigger barraria a criação
-- legítima do perfil do DONO de uma empresa nova (papel='dono').
--
-- DECISÃO DE SEGURANÇA:
-- O service_role é a "chave-mestra" do backend, usada SOMENTE no servidor e
-- nunca exposta ao browser. O propósito destas triggers é impedir escalada de
-- privilégio por usuários FINAIS autenticados — não restringir o backend
-- confiável. Por isso liberamos explicitamente o contexto service_role,
-- mantendo a proteção intacta para 'authenticated'.
--
-- Detecção: auth.role() lê a role das claims do JWT. Em chamadas com a
-- service_role key, auth.role() = 'service_role'.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- UPDATE (atualiza a função criada em 002)
-- ----------------------------------------------------------------------------
create or replace function public.proteger_colunas_sensiveis_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Backend confiável (service_role) e superadmin passam livres.
  if auth.role() = 'service_role' or public.sou_super_admin() then
    return new;
  end if;

  if new.papel is distinct from old.papel then
    raise exception 'Alteração não permitida: somente o superadmin pode alterar o papel do perfil.'
      using errcode = '42501';
  end if;

  if new.is_super_admin is distinct from old.is_super_admin then
    raise exception 'Alteração não permitida: somente o superadmin pode alterar is_super_admin.'
      using errcode = '42501';
  end if;

  if new.empresa_id is distinct from old.empresa_id then
    raise exception 'Alteração não permitida: somente o superadmin pode alterar a empresa do perfil.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- INSERT (atualiza a função criada em 003)
-- ----------------------------------------------------------------------------
create or replace function public.proteger_insert_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Backend confiável (service_role) e superadmin podem criar qualquer perfil.
  if auth.role() = 'service_role' or public.sou_super_admin() then
    return new;
  end if;

  if coalesce(new.is_super_admin, false) is true then
    raise exception 'Criação não permitida: somente o superadmin pode criar perfil com is_super_admin = true.'
      using errcode = '42501';
  end if;

  if new.papel = 'dono' then
    raise exception 'Criação não permitida: somente o superadmin pode criar perfil com papel = ''dono''.'
      using errcode = '42501';
  end if;

  if new.empresa_id is distinct from public.get_minha_empresa() then
    raise exception 'Criação não permitida: o perfil deve pertencer à sua própria empresa.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- As triggers em si (002/003) continuam válidas; só atualizamos as funções.
