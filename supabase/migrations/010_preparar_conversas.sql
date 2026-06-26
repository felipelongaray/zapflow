-- =============================================================================
-- ZapFlow — Preparar canais / conversas / mensagens para a tela de conversa
-- =============================================================================
-- As três tabelas já nasceram na 001, mas sem uso e incompletas. Esta migration
-- ajusta SÓ o que falta, sem duplicar coluna nem quebrar o que existe.
--
-- RESUMO DAS MUDANÇAS (detalhe em cada bloco):
--   CANAIS    — re-domina `tipo` para ('oficial','nao_oficial'), NOT NULL + default.
--   CONVERSAS — adiciona `ultima_mensagem_em` (ordenação da lista).
--   MENSAGENS — adiciona `status` (mantém `created_at`, padrão das demais tabelas).
--   RLS       — reafirma as policies multi-tenant das três (idempotente) e
--               concede GRANT também ao service_role.
--   ÍNDICES   — lista de conversas e thread de mensagens.
--
-- Não implementa a conexão real do WhatsApp — só a estrutura.
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. CANAIS
-- ----------------------------------------------------------------------------
-- Já tinha: id, empresa_id, nome, numero, tipo (CHECK 'normal'/'business'/'api'),
--           status (default 'desconectado'), created_at.
-- Mudança: o domínio de `tipo` agora é 'oficial' | 'nao_oficial', NOT NULL e com
--          default 'oficial'. `nome`, `empresa_id`, `status`, `created_at` ficam
--          como estão (status segue text livre com default 'desconectado' — não
--          forço 'ativo'/'inativo' para não quebrar o default existente).

-- 1a. Normaliza valores fora do novo domínio ANTES de aplicar o novo CHECK.
--     (Tabela sem uso; mapeia qualquer valor antigo/NULL para 'oficial'.)
update public.canais
   set tipo = 'oficial'
 where tipo is null
    or tipo not in ('oficial', 'nao_oficial');

-- 1b. Remove o CHECK antigo (nome gerado pelo Postgres na 001).
alter table public.canais drop constraint if exists canais_tipo_check;

-- 1c. Aplica default, obrigatoriedade e o novo domínio.
alter table public.canais alter column tipo set default 'oficial';
alter table public.canais alter column tipo set not null;
alter table public.canais
  add constraint canais_tipo_check check (tipo in ('oficial', 'nao_oficial'));

-- Garante `nome` (já existe; idempotente).
alter table public.canais add column if not exists nome text;

-- ----------------------------------------------------------------------------
-- 2. CONVERSAS
-- ----------------------------------------------------------------------------
-- Já tinha: id, empresa_id, contato_id (FK), canal_id (FK), atendente_id (FK),
--           status (default 'aberta'), created_at.
-- Mudança: adiciona `ultima_mensagem_em` para ordenar a lista de conversas
--          (a mais recente no topo). Default now() para já nascer ordenável;
--          o app atualizará esse campo a cada nova mensagem.
alter table public.conversas
  add column if not exists ultima_mensagem_em timestamptz not null default now();

-- ----------------------------------------------------------------------------
-- 3. MENSAGENS
-- ----------------------------------------------------------------------------
-- Já tinha: id, empresa_id, conversa_id (FK), conteudo, direcao
--           (CHECK 'entrada'/'saida'), created_at.
-- Mudança: adiciona apenas `status`. `created_at` é MANTIDO (padrão consistente
--          com as demais tabelas; evita mexer em limpar_mensagens_antigas, que
--          já usa created_at). `direcao` e seu CHECK já batem com o pedido.

-- status do envio (para o futuro: ticks de entregue/lida). Sem CHECK rígido de
-- propósito — mensagens de 'entrada' poderão usar outros valores (ex:
-- 'recebida') sem precisar de nova migration. Default cobre o caso comum.
alter table public.mensagens
  add column if not exists status text not null default 'enviada';

-- ----------------------------------------------------------------------------
-- 4. ÍNDICES ÚTEIS
-- ----------------------------------------------------------------------------
-- Lista de conversas da empresa, mais recentes primeiro.
create index if not exists conversas_empresa_ultima_msg_idx
  on public.conversas (empresa_id, ultima_mensagem_em desc);

-- Thread de uma conversa em ordem cronológica.
create index if not exists mensagens_conversa_created_idx
  on public.mensagens (conversa_id, created_at);

-- ----------------------------------------------------------------------------
-- 5. RLS MULTI-TENANT (reafirmado, idempotente) + GRANTS
-- ----------------------------------------------------------------------------
-- As policies já existiam na 001 com o padrão correto. Reafirmo aqui (drop +
-- create) para esta migration ser autocontida e garantir o WITH CHECK que
-- impede cross-tenant em INSERT/UPDATE. A leitura (USING) e a escrita (WITH
-- CHECK) usam superadmin OU empresa_id = get_minha_empresa().

alter table public.canais    enable row level security;
alter table public.conversas enable row level security;
alter table public.mensagens enable row level security;

-- canais
drop policy if exists canais_select on public.canais;
create policy canais_select on public.canais
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists canais_insert on public.canais;
create policy canais_insert on public.canais
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists canais_update on public.canais;
create policy canais_update on public.canais
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists canais_delete on public.canais;
create policy canais_delete on public.canais
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- conversas
drop policy if exists conversas_select on public.conversas;
create policy conversas_select on public.conversas
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists conversas_insert on public.conversas;
create policy conversas_insert on public.conversas
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists conversas_update on public.conversas;
create policy conversas_update on public.conversas
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists conversas_delete on public.conversas;
create policy conversas_delete on public.conversas
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- mensagens
drop policy if exists mensagens_select on public.mensagens;
create policy mensagens_select on public.mensagens
  for select to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists mensagens_insert on public.mensagens;
create policy mensagens_insert on public.mensagens
  for insert to authenticated
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists mensagens_update on public.mensagens;
create policy mensagens_update on public.mensagens
  for update to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa())
  with check (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

drop policy if exists mensagens_delete on public.mensagens;
create policy mensagens_delete on public.mensagens
  for delete to authenticated
  using (public.sou_super_admin() or empresa_id = public.get_minha_empresa());

-- GRANTs: authenticated (operação sob RLS) e service_role (backend confiável,
-- ex.: ingestão de mensagens recebidas via webhook). O RLS continua filtrando
-- por tenant para authenticated; o service_role ignora RLS por design.
grant select, insert, update, delete on public.canais    to authenticated, service_role;
grant select, insert, update, delete on public.conversas to authenticated, service_role;
grant select, insert, update, delete on public.mensagens to authenticated, service_role;
