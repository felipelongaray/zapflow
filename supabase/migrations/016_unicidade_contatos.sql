-- =============================================================================
-- ZapFlow — Unicidade de contatos e conversas (anti-duplicação do webhook)
-- =============================================================================
-- PROBLEMA: o webhook criava contatos/conversas DUPLICADOS para o mesmo celular,
-- por (1) telefones gravados em tamanhos diferentes (11 vs 13 dígitos) e (2) race
-- condition entre requests simultâneos (vários "select; senão insert" em paralelo).
--
-- DECISÃO DE PRODUTO: um celular = UM contato por empresa (independente de canal).
-- Chave de unicidade: (empresa_id, telefone), com telefone SEMPRE canonicalizado
-- em 13 dígitos (DDI 55 + DDD + 9 + número, reinserindo o nono dígito do celular).
--
-- Esta migration NÃO altera nenhuma policy de RLS, nenhum GRANT e nenhum helper
-- SECURITY DEFINER. Ela só (a) canonicaliza os telefones existentes, (b) cria a
-- UNIQUE de contatos e (c) cria o partial unique index de conversas abertas.
-- Não toca em access_token, canais nem em qualquer coluna sensível.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. CANONICALIZAÇÃO dos telefones existentes em contatos
-- ----------------------------------------------------------------------------
-- Reproduz FIELMENTE lib/telefone.ts -> normalizarWhatsApp:
--   d        = apenas dígitos
--   (guard)  = se não houver dígitos, NÃO mexe na linha (equivale ao return "" do JS)
--   com_ddi  = (length(d) > 11 e começa com '55') ? d : '55' || d
--   ddd      = com_ddi[3..4]   (slice(2,4) do JS, 1-based no SQL)
--   assinante= com_ddi[5..]    (slice(4) do JS)
--   se length(ddd) < 2 OU assinante vazio        -> com_ddi (melhor esforço)
--   se assinante tem 8 díg e começa em 6-9        -> '55' || ddd || '9' || assinante
--   senão                                         -> com_ddi
update public.contatos c
set telefone = sub.canonico
from (
  select
    id,
    case
      when length(ddd) < 2 or length(assinante) = 0 then com_ddi
      when length(assinante) = 8 and left(assinante, 1) ~ '[6-9]'
        then '55' || ddd || '9' || assinante
      else com_ddi
    end as canonico
  from (
    select
      id,
      com_ddi,
      substr(com_ddi, 3, 2) as ddd,
      substr(com_ddi, 5)    as assinante
    from (
      select
        id,
        case
          when length(d) > 11 and left(d, 2) = '55' then d
          else '55' || d
        end as com_ddi
      from (
        select id, regexp_replace(coalesce(telefone, ''), '[^0-9]', '', 'g') as d
        from public.contatos
      ) q1
      -- Sem dígitos: fiel ao guard `if (!d) return ""` do JS — não normalizamos.
      where d <> ''
    ) q2
  ) q3
) sub
where c.id = sub.id
  and c.telefone is distinct from sub.canonico;

-- ----------------------------------------------------------------------------
-- 2. VERIFICAÇÃO de duplicatas (rode ANTES de aplicar a UNIQUE do passo 3)
-- ----------------------------------------------------------------------------
-- A UNIQUE abaixo FALHA se ainda houver duplicatas de (empresa_id, telefone)
-- após a canonicalização. Os dados de teste já foram limpos do nosso lado, mas
-- rode este SELECT para confirmar que o resultado é VAZIO antes de seguir:
--
--   select empresa_id, telefone, count(*) as qtd, array_agg(id) as ids
--   from public.contatos
--   group by empresa_id, telefone
--   having count(*) > 1
--   order by qtd desc;
--
-- Se vier alguma linha, resolva o merge dos contatos (mover conversas/mensagens
-- para o id sobrevivente e apagar os demais) ANTES de criar a constraint.

-- ----------------------------------------------------------------------------
-- 3. UNIQUE em contatos: um telefone canônico = um contato por empresa
-- ----------------------------------------------------------------------------
-- Unique index (idempotente via IF NOT EXISTS). É a trava FÍSICA que mata a race
-- condition: ainda que dois requests tentem inserir o mesmo (empresa_id,
-- telefone) ao mesmo tempo, só um vence — o outro recebe violação de unicidade
-- (que o passo seguinte do projeto, no webhook, tratará com upsert/retry).
create unique index if not exists contatos_empresa_telefone_uniq
  on public.contatos (empresa_id, telefone);

-- ----------------------------------------------------------------------------
-- 4. PARTIAL UNIQUE INDEX em conversas: no máx. UMA conversa 'aberta' por contato
-- ----------------------------------------------------------------------------
-- PARCIAL (where status = 'aberta') de propósito: o histórico pode ter VÁRIAS
-- conversas fechadas/arquivadas do mesmo contato ao longo do tempo; a unicidade
-- só vale para o estado ATIVO. Assim uma conversa pode ser fechada e outra
-- aberta depois sem conflito, mas nunca existem DUAS abertas simultâneas para o
-- mesmo contato. (contato_id já é exclusivo de uma empresa, então não precisa de
-- empresa_id no índice.)
create unique index if not exists conversas_contato_aberta_uniq
  on public.conversas (contato_id)
  where status = 'aberta';
