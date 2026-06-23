-- =============================================================================
-- ZapFlow — Seed de contatos fictícios para demonstrar o funil
-- =============================================================================
-- Insere 8 contatos de exemplo distribuídos pelas etapas padrão (Novo / Em
-- atendimento / Fechado) de UMA empresa, mais 1 sem etapa (para exibir a coluna
-- "Sem etapa" no Kanban).
--
-- COMO RODAR / AJUSTAR:
--  - Por padrão, o script usa a PRIMEIRA empresa existente (mais antiga).
--  - Se quiser fixar uma empresa específica, comente a linha do SELECT e use a
--    linha do literal logo abaixo, colando o id da sua empresa de teste.
--  - É seguro rodar mais de uma vez? NÃO — rodar de novo duplica os contatos.
--    Para limpar os de demonstração: delete from public.contatos where
--    telefone like '(%) 9%' and nome in (...);  (ou recrie a empresa).
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

do $$
declare
  v_empresa uuid;
  v_novo    uuid;
  v_atend   uuid;
  v_fechado uuid;
begin
  -- (A) Empresa-alvo: primeira empresa existente.
  select id into v_empresa from public.empresas order by created_at asc limit 1;

  -- (B) Alternativa: fixe o id da sua empresa de teste e comente o SELECT acima.
  -- v_empresa := '00000000-0000-0000-0000-000000000000';

  if v_empresa is null then
    raise notice 'Nenhuma empresa encontrada — nada a semear.';
    return;
  end if;

  -- Resolve as etapas padrão por nome (criadas por criar_etapas_padrao).
  select id into v_novo    from public.etapas where empresa_id = v_empresa and nome = 'Novo'           limit 1;
  select id into v_atend   from public.etapas where empresa_id = v_empresa and nome = 'Em atendimento' limit 1;
  select id into v_fechado from public.etapas where empresa_id = v_empresa and nome = 'Fechado'        limit 1;

  if v_novo is null then
    raise notice 'Etapas padrão não encontradas para a empresa % — rode criar_etapas_padrao antes.', v_empresa;
    return;
  end if;

  -- Contatos de demonstração. A coluna textual antiga `etapa` é preenchida só
  -- por compatibilidade; o funil usa etapa_id.
  insert into public.contatos (empresa_id, nome, telefone, etapa_id, etapa) values
    (v_empresa, 'João Pereira',      '(11) 98877-1234', v_novo,    'novo'),
    (v_empresa, 'Maria Oliveira',    '(21) 99654-2210', v_novo,    'novo'),
    (v_empresa, 'Carlos Eduardo',    '(31) 98123-9988', v_novo,    'novo'),
    (v_empresa, 'Ana Beatriz Souza', '(41) 99876-3344', v_atend,   'em_atendimento'),
    (v_empresa, 'Rafael Lima',       '(51) 98456-7711', v_atend,   'em_atendimento'),
    (v_empresa, 'Fernanda Costa',    '(61) 99211-5567', v_fechado, 'fechado'),
    (v_empresa, 'Bruno Almeida',     '(71) 98322-4490', v_fechado, 'fechado'),
    (v_empresa, 'Patrícia Gomes',    '(85) 99744-8123', null,      'novo');

  raise notice 'Seed concluído para a empresa %.', v_empresa;
end $$;
