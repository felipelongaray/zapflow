-- =============================================================================
-- ZapFlow — Blindagem contra escalada de privilégio em perfis
-- =============================================================================
-- A policy de UPDATE de perfis (migration 001) permite que o usuário edite o
-- PRÓPRIO perfil. Isso é desejável para campos como "nome", mas perigoso para
-- as colunas sensíveis: papel, is_super_admin e empresa_id — um atendente
-- poderia se promover a 'dono', virar superadmin ou se mover de empresa.
--
-- RLS sozinho não resolve bem esse caso: WITH CHECK valida o ESTADO FINAL da
-- linha, mas não compara facilmente "valor antigo vs novo" de cada coluna. Uma
-- trigger BEFORE UPDATE é a ferramenta certa, pois tem acesso a OLD e NEW.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

create or replace function public.proteger_colunas_sensiveis_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Superadmin pode alterar qualquer coluna, inclusive as sensíveis.
  if public.sou_super_admin() then
    return new;
  end if;

  -- Para qualquer outro usuário, bloqueia mudança nas três colunas sensíveis.
  -- "is distinct from" trata NULL corretamente (NULL <> NULL daria NULL, e o
  -- IF ignoraria a mudança; "is distinct from" retorna TRUE quando um lado é
  -- NULL e o outro não).
  if new.papel is distinct from old.papel then
    raise exception 'Alteração não permitida: somente o superadmin pode alterar o papel do perfil.'
      using errcode = '42501'; -- insufficient_privilege
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

-- BEFORE UPDATE: roda antes da gravação, então o RAISE aborta a transação e
-- nenhuma linha é alterada. FOR EACH ROW: avalia OLD/NEW por linha afetada.
drop trigger if exists trg_proteger_colunas_sensiveis_perfil on public.perfis;

create trigger trg_proteger_colunas_sensiveis_perfil
  before update on public.perfis
  for each row
  execute function public.proteger_colunas_sensiveis_perfil();
