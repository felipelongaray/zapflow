-- =============================================================================
-- ZapFlow — Retenção configurável de mensagens por empresa
-- =============================================================================
-- Cada empresa define por quantos dias suas mensagens são mantidas. Uma função
-- de limpeza apaga as mensagens mais antigas que esse limite, por empresa.
--
-- NÃO agendamos a execução aqui (sem pg_cron). A função fica pronta para ser
-- chamada manualmente ou agendada depois. Ver nota no fim do arquivo.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Coluna de retenção na empresa
-- ----------------------------------------------------------------------------
alter table public.empresas
  add column if not exists dias_retencao_mensagens int not null default 90;

-- Opcional, mas saudável: garantir um valor positivo.
alter table public.empresas
  drop constraint if exists empresas_dias_retencao_positivo;
alter table public.empresas
  add constraint empresas_dias_retencao_positivo
  check (dias_retencao_mensagens > 0);

-- ----------------------------------------------------------------------------
-- 2. Função de limpeza
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER: a limpeza é uma rotina administrativa global que precisa
-- apagar mensagens de TODAS as empresas, ignorando o RLS. Rodando como o dono
-- da função, ela não é filtrada pelas policies por tenant.
--
-- Faz um único DELETE com JOIN em empresas, comparando created_at com o limite
-- específico de cada empresa (make_interval converte os dias em intervalo).
-- Retorna quantas mensagens foram apagadas (útil para logs/monitoramento).
create or replace function public.limpar_mensagens_antigas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total_apagadas integer;
begin
  with apagadas as (
    delete from public.mensagens m
    using public.empresas e
    where m.empresa_id = e.id
      and m.created_at < now() - make_interval(days => e.dias_retencao_mensagens)
    returning m.id
  )
  select count(*) into total_apagadas from apagadas;

  return total_apagadas;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Permissões
-- ----------------------------------------------------------------------------
-- NÃO concedemos execute ao role authenticated: esta é uma rotina de
-- manutenção, não algo que o atendente/dono deva disparar. Por padrão apenas
-- o owner (postgres) e roles superiores podem executá-la — exatamente o que
-- queremos para uma chamada manual sua ou via job agendado.
revoke all on function public.limpar_mensagens_antigas() from public;

-- =============================================================================
-- COMO AGENDAR DEPOIS (quando o volume justificar)
-- =============================================================================
-- Opção A — pg_cron (extensão nativa no Supabase):
--
--   create extension if not exists pg_cron;
--   -- Roda todo dia às 03:00 (horário do servidor / UTC):
--   select cron.schedule(
--     'limpar-mensagens-antigas',
--     '0 3 * * *',
--     $$ select public.limpar_mensagens_antigas(); $$
--   );
--   -- Para remover depois: select cron.unschedule('limpar-mensagens-antigas');
--
-- Opção B — Supabase Scheduled Edge Function / cron externo chamando uma RPC:
--   um serviço externo (ou Edge Function) invoca a função via service_role em
--   intervalo fixo. Útil se você quiser logs/alertas no fluxo da aplicação.
--
-- Recomendação: comece chamando manualmente
--   select public.limpar_mensagens_antigas();
-- e só agende quando o volume de mensagens crescer o suficiente para justificar.
-- =============================================================================
