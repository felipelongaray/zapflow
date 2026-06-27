-- =============================================================================
-- ZapFlow — Guardar o id da mensagem no Meta (wamid) em mensagens
-- =============================================================================
-- A Cloud API retorna, em cada envio bem-sucedido, um id (wamid). Os callbacks
-- de STATUS do webhook (sent/delivered/read) referenciam esse mesmo id. Guardá-lo
-- permite, no futuro, casar o callback com a mensagem certa e atualizar o status
-- (enviada -> entregue -> lida).
--
-- Coluna nullable: mensagens de 'entrada' (recebidas) e registros antigos podem
-- não ter wamid. Não altera RLS/GRANTs — só adiciona a coluna e um índice.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

alter table public.mensagens
  add column if not exists meta_message_id text;

-- Índice para o lookup do webhook por wamid (achar a mensagem a atualizar).
-- Não-único de propósito: evita falhar caso o Meta repita um id em retries; a
-- unicidade pode ser endurecida depois, se o volume/uso justificar.
create index if not exists mensagens_meta_message_id_idx
  on public.mensagens (meta_message_id);
