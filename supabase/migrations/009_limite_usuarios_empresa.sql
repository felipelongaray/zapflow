-- =============================================================================
-- ZapFlow — Teto de usuários por empresa (rede de segurança no banco)
-- =============================================================================
-- A criação de atendentes (rota POST /api/empresa/usuarios) já valida o limite
-- max_usuarios NO SERVIDOR antes de inserir. Esta trigger é DEFESA EM
-- PROFUNDIDADE: garante o teto mesmo numa corrida (dois cadastros simultâneos
-- que passem na contagem do app ao mesmo tempo) e mesmo que algum caminho de
-- INSERT futuro esqueça de checar.
--
-- POR QUE TRIGGER (e não RLS): o limite depende de uma AGREGAÇÃO (contar perfis
-- da empresa) comparada a um valor de OUTRA tabela (empresas.max_usuarios). RLS
-- (WITH CHECK) avalia a linha isolada, não uma contagem; trigger é a ferramenta
-- certa. Ela roda inclusive para o service_role (triggers não são ignoradas como
-- o RLS), o que é desejável: o teto vale para qualquer caminho de escrita.
--
-- COMPATIBILIDADE COM O PROVISIONAMENTO: ao criar uma empresa nova, o perfil do
-- DONO é o 1º perfil (contagem = 0 < max_usuarios, que é >= 1), então passa.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

create or replace function public.checar_limite_usuarios_empresa()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max   int;
  v_atual int;
begin
  -- Perfil sem empresa (ex.: superadmin) não consome cota de nenhum tenant.
  if new.empresa_id is null then
    return new;
  end if;

  select max_usuarios into v_max
  from public.empresas
  where id = new.empresa_id;

  -- Empresa inexistente: deixa a FK/constraint normal acusar o erro.
  if v_max is null then
    return new;
  end if;

  select count(*) into v_atual
  from public.perfis
  where empresa_id = new.empresa_id;

  if v_atual >= v_max then
    raise exception 'Limite de usuários da empresa atingido (% de %).', v_atual, v_max
      using errcode = '23514'; -- check_violation
  end if;

  return new;
end;
$$;

-- BEFORE INSERT: aborta a transação antes de gravar se a empresa já está no teto.
drop trigger if exists trg_checar_limite_usuarios_empresa on public.perfis;

create trigger trg_checar_limite_usuarios_empresa
  before insert on public.perfis
  for each row
  execute function public.checar_limite_usuarios_empresa();
