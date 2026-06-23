-- =============================================================================
-- ZapFlow — Blindagem contra escalada de privilégio no INSERT de perfis
-- =============================================================================
-- A migration 002 protege o UPDATE (impede promover-se editando o próprio
-- perfil). Mas falta o flanco do INSERT: um usuário não-superadmin poderia
-- CRIAR um perfil já "nascido elevado" — com is_super_admin = true, papel
-- 'dono', ou apontando para uma empresa que não é a dele.
--
-- A policy de INSERT da migration 001 já exige (para não-superadmin)
-- id = auth.uid() e empresa_id = get_minha_empresa(). Esta trigger reforça e
-- complementa, barrando explicitamente os valores ELEVADOS (papel/is_super_admin)
-- e dando mensagens de erro claras.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

create or replace function public.proteger_insert_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Superadmin pode criar qualquer perfil, com quaisquer valores.
  if public.sou_super_admin() then
    return new;
  end if;

  -- Não-superadmin não pode criar um perfil já como superadmin.
  if coalesce(new.is_super_admin, false) is true then
    raise exception 'Criação não permitida: somente o superadmin pode criar perfil com is_super_admin = true.'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- Não-superadmin não pode criar um perfil com papel elevado ('dono').
  if new.papel = 'dono' then
    raise exception 'Criação não permitida: somente o superadmin pode criar perfil com papel = ''dono''.'
      using errcode = '42501';
  end if;

  -- Não-superadmin só pode criar perfil dentro da PRÓPRIA empresa.
  -- (is distinct from cobre o caso de empresa_id NULL, que tentaria criar um
  -- perfil "sem empresa" no estilo superadmin.)
  if new.empresa_id is distinct from public.get_minha_empresa() then
    raise exception 'Criação não permitida: o perfil deve pertencer à sua própria empresa.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT: aborta antes da gravação se algum valor for elevado.
drop trigger if exists trg_proteger_insert_perfil on public.perfis;

create trigger trg_proteger_insert_perfil
  before insert on public.perfis
  for each row
  execute function public.proteger_insert_perfil();
