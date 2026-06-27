-- =============================================================================
-- ZapFlow — Credenciais do WhatsApp Cloud API (Meta) por canal/empresa
-- =============================================================================
-- Cada empresa tem seu próprio número/canal com credenciais próprias. Aqui
-- adicionamos os campos da Cloud API à tabela canais e endurecemos as policies:
-- só o DONO gerencia canais; atendentes apenas leem.
--
-- O que canais JÁ tinha (001 + 010): id, empresa_id, nome, numero,
--   tipo ('oficial'/'nao_oficial'), status (default 'desconectado'), created_at.
-- Esta migration NÃO altera essas colunas — só ADICIONA as credenciais.
--
-- ⚠️  SENSIBILIDADE: access_token e verify_token são SEGREDOS. Veja a seção de
--     segurança no fim do arquivo.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Colunas da Cloud API (todas nullable — um canal pode existir antes de ser
--    configurado/conectado). add column if not exists = idempotente.
-- ----------------------------------------------------------------------------
alter table public.canais
  add column if not exists phone_number_id text;               -- Phone Number ID (Meta)

alter table public.canais
  add column if not exists whatsapp_business_account_id text;  -- WABA ID (uso futuro)

alter table public.canais
  add column if not exists access_token text;                  -- token de acesso (SEGREDO)

alter table public.canais
  add column if not exists verify_token text;                  -- token de verificação do webhook (SEGREDO)

-- ----------------------------------------------------------------------------
-- 2. RLS — isolamento por empresa + escrita só do DONO
-- ----------------------------------------------------------------------------
-- Reafirmamos as policies de canais (idempotente) endurecendo a ESCRITA:
--   - SELECT: qualquer usuário da empresa (dono E atendente) — superadmin tudo.
--             O isolamento por empresa (empresa_id = get_minha_empresa()) garante
--             que NENHUMA empresa lê as credenciais de outra.
--   - INSERT/UPDATE/DELETE: só o DONO (sou_dono_da_empresa()), como nas etapas
--             (008) e nos templates (012). Atendente não cria/edita/apaga canal
--             nem mexe em credenciais.
--   - WITH CHECK replica a condição para impedir criar/mover canal para outra
--             empresa (anti-cross-tenant).
alter table public.canais enable row level security;

drop policy if exists canais_select on public.canais;
create policy canais_select on public.canais
  for select to authenticated
  using (
    public.sou_super_admin()
    or empresa_id = public.get_minha_empresa()
  );

drop policy if exists canais_insert on public.canais;
create policy canais_insert on public.canais
  for insert to authenticated
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists canais_update on public.canais;
create policy canais_update on public.canais
  for update to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  )
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists canais_delete on public.canais;
create policy canais_delete on public.canais
  for delete to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

-- ----------------------------------------------------------------------------
-- 3. GRANTs — authenticated (sob RLS) e service_role (lê o token NO SERVIDOR
--    para chamar a API do Meta). Idempotente.
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.canais to authenticated, service_role;

-- =============================================================================
-- SEGURANÇA — leia antes de implementar o envio
-- =============================================================================
-- 1) ISOLAMENTO POR EMPRESA (RLS): access_token e verify_token vivem em linhas de
--    canais, protegidas pelas policies acima. Como SELECT exige
--    empresa_id = get_minha_empresa() (ou superadmin), uma empresa JAMAIS lê as
--    credenciais de outra. get_minha_empresa()/sou_dono_da_empresa() são
--    SECURITY DEFINER com search_path fixo, então não dá para burlar via RLS.
--
-- 2) NÃO TRAFEGAR O TOKEN PARA O BROWSER: o RLS isola por empresa, mas mesmo o
--    dono não precisa do access_token no front. Regra de implementação (a valer
--    quando construirmos as telas/rotas):
--      - Ao listar/editar canais no client, faça SELECT EXPLÍCITO das colunas,
--        OMITINDO access_token e verify_token (ex.: select id, nome, numero,
--        tipo, status, phone_number_id, whatsapp_business_account_id). Nunca
--        `select *` num canal indo para o browser.
--      - O envio de mensagem e a verificação do webhook leem o token SEMPRE no
--        SERVIDOR (Route Handler/Server Action), via service_role ou cliente de
--        servidor, e chamam a API do Meta a partir dali. O token nunca chega ao
--        bundle do cliente.
--      - Reforço opcional futuro: mover os segredos para uma tabela separada
--        (ex.: canais_credenciais) sem GRANT de SELECT para authenticated (só
--        service_role), ou usar Vault/pgsodium para cifrar em repouso. Não é
--        necessário nesta fase; o isolamento por empresa + token só-no-servidor
--        já cobre o essencial.
--
-- 3) service_role: ignora RLS por design e roda apenas no backend confiável.
--    É ele quem lê o token para falar com o Meta. Nunca é exposto ao browser
--    (chave sem prefixo NEXT_PUBLIC_, ver lib/supabase/admin.ts).
-- =============================================================================
