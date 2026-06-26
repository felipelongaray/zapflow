-- =============================================================================
-- ZapFlow — Seed de conversas/mensagens fictícias para a tela de conversa
-- =============================================================================
-- Cria, para a PRIMEIRA empresa existente:
--   - 1 canal de WhatsApp de exemplo ("WhatsApp Vendas", tipo 'oficial').
--   - até 4 conversas (uma por contato já existente da empresa), com
--     ultima_mensagem_em escalonado para testar a ordenação da lista.
--   - 5 a 6 mensagens por conversa, alternando 'entrada'/'saida', com created_at
--     crescente. ultima_mensagem_em da conversa = created_at da última mensagem.
--
-- COMO RODAR / AJUSTAR:
--  - Por padrão usa a PRIMEIRA empresa (mais antiga). Para fixar outra, comente o
--    SELECT em (A) e use o literal em (B), colando o id da sua empresa de teste.
--  - Precisa haver contatos na empresa (rode o seed 007 antes, se necessário).
--
-- IDEMPOTÊNCIA: NÃO é idempotente — rodar de novo cria outro canal e novas
-- conversas/mensagens. Para limpar APENAS este seed (ordem importa por causa do
-- on delete set null em conversas.canal_id):
--   delete from public.mensagens m using public.conversas c
--     where m.conversa_id = c.id
--       and c.canal_id in (select id from public.canais where nome = 'WhatsApp Vendas');
--   delete from public.conversas
--     where canal_id in (select id from public.canais where nome = 'WhatsApp Vendas');
--   delete from public.canais where nome = 'WhatsApp Vendas';
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

do $$
declare
  v_empresa uuid;
  v_canal   uuid;
  v_conv    uuid;
  v_last    timestamptz;
  v_c1      uuid;
  v_c2      uuid;
  v_c3      uuid;
  v_c4      uuid;
begin
  -- (A) Empresa-alvo: primeira empresa existente.
  select id into v_empresa from public.empresas order by created_at asc limit 1;

  -- (B) Alternativa: fixe o id da sua empresa e comente o SELECT acima.
  -- v_empresa := '00000000-0000-0000-0000-000000000000';

  if v_empresa is null then
    raise notice 'Nenhuma empresa encontrada — nada a semear.';
    return;
  end if;

  -- Canal de exemplo (não conecta no WhatsApp real; é só estrutura/visual).
  insert into public.canais (empresa_id, nome, numero, tipo, status)
  values (v_empresa, 'WhatsApp Vendas', '5511999990000', 'oficial', 'conectado')
  returning id into v_canal;

  -- Até 4 contatos existentes da empresa (mais antigos primeiro).
  select id into v_c1 from public.contatos where empresa_id = v_empresa order by created_at asc offset 0 limit 1;
  select id into v_c2 from public.contatos where empresa_id = v_empresa order by created_at asc offset 1 limit 1;
  select id into v_c3 from public.contatos where empresa_id = v_empresa order by created_at asc offset 2 limit 1;
  select id into v_c4 from public.contatos where empresa_id = v_empresa order by created_at asc offset 3 limit 1;

  if v_c1 is null then
    raise notice 'Empresa % não tem contatos — rode o seed 007 antes.', v_empresa;
    return;
  end if;

  -- -------------------------------------------------------------------------
  -- Conversa 1 — Consignado (a MAIS recente: aparece no topo da lista)
  -- -------------------------------------------------------------------------
  if v_c1 is not null then
    v_last := now() - interval '2 minutes';
    insert into public.conversas (empresa_id, canal_id, contato_id, status, created_at, ultima_mensagem_em)
      values (v_empresa, v_canal, v_c1, 'aberta', v_last - interval '15 minutes', v_last)
      returning id into v_conv;

    insert into public.mensagens (empresa_id, conversa_id, direcao, conteudo, status, created_at) values
      (v_empresa, v_conv, 'entrada', 'Oi, vi o anúncio de vocês. Trabalham com empréstimo consignado?', 'recebida', v_last - interval '15 minutes'),
      (v_empresa, v_conv, 'saida',   'Olá! Sim, trabalhamos com consignado para aposentados e servidores. Você é de qual categoria?', 'lida', v_last - interval '12 minutes'),
      (v_empresa, v_conv, 'entrada', 'Sou aposentada pelo INSS.', 'recebida', v_last - interval '9 minutes'),
      (v_empresa, v_conv, 'saida',   'Perfeito! Para o INSS conseguimos taxas a partir de 1,66% ao mês. Qual valor você precisa?', 'lida', v_last - interval '6 minutes'),
      (v_empresa, v_conv, 'entrada', 'Preciso de uns R$ 8.000.', 'recebida', v_last - interval '3 minutes'),
      (v_empresa, v_conv, 'saida',   'Consigo simular agora. Pode me informar sua data de nascimento, por favor?', 'enviada', v_last);
  end if;

  -- -------------------------------------------------------------------------
  -- Conversa 2 — Portabilidade (≈ 1h atrás)
  -- -------------------------------------------------------------------------
  if v_c2 is not null then
    v_last := now() - interval '1 hour';
    insert into public.conversas (empresa_id, canal_id, contato_id, status, created_at, ultima_mensagem_em)
      values (v_empresa, v_canal, v_c2, 'aberta', v_last - interval '20 minutes', v_last)
      returning id into v_conv;

    insert into public.mensagens (empresa_id, conversa_id, direcao, conteudo, status, created_at) values
      (v_empresa, v_conv, 'entrada', 'Bom dia, já tenho um consignado em outro banco. Dá pra fazer portabilidade?', 'recebida', v_last - interval '20 minutes'),
      (v_empresa, v_conv, 'saida',   'Bom dia! Sim, fazemos portabilidade e normalmente reduzimos a parcela. Sabe quanto ainda falta pagar?', 'lida', v_last - interval '16 minutes'),
      (v_empresa, v_conv, 'entrada', 'Faltam 48 parcelas de R$ 320.', 'recebida', v_last - interval '10 minutes'),
      (v_empresa, v_conv, 'saida',   'Com a portabilidade a parcela pode cair para perto de R$ 270. Posso te enviar a simulação?', 'lida', v_last - interval '6 minutes'),
      (v_empresa, v_conv, 'entrada', 'Pode sim, por favor.', 'recebida', v_last - interval '2 minutes'),
      (v_empresa, v_conv, 'saida',   'Enviado! Qualquer dúvida estou à disposição.', 'entregue', v_last);
  end if;

  -- -------------------------------------------------------------------------
  -- Conversa 3 — Status da proposta (≈ 3h atrás)
  -- -------------------------------------------------------------------------
  if v_c3 is not null then
    v_last := now() - interval '3 hours';
    insert into public.conversas (empresa_id, canal_id, contato_id, status, created_at, ultima_mensagem_em)
      values (v_empresa, v_canal, v_c3, 'aberta', v_last - interval '8 minutes', v_last)
      returning id into v_conv;

    insert into public.mensagens (empresa_id, conversa_id, direcao, conteudo, status, created_at) values
      (v_empresa, v_conv, 'entrada', 'Oi, queria saber como está minha proposta.', 'recebida', v_last - interval '8 minutes'),
      (v_empresa, v_conv, 'saida',   'Oi! Sua proposta está em análise no banco, normalmente sai em até 1 dia útil.', 'lida', v_last - interval '5 minutes'),
      (v_empresa, v_conv, 'entrada', 'Beleza, obrigado.', 'recebida', v_last - interval '3 minutes'),
      (v_empresa, v_conv, 'saida',   'Assim que aprovar eu te aviso por aqui!', 'lida', v_last - interval '1 minute'),
      (v_empresa, v_conv, 'entrada', 'Combinado!', 'recebida', v_last);
  end if;

  -- -------------------------------------------------------------------------
  -- Conversa 4 — Documentos (≈ 1 dia atrás)
  -- -------------------------------------------------------------------------
  if v_c4 is not null then
    v_last := now() - interval '1 day';
    insert into public.conversas (empresa_id, canal_id, contato_id, status, created_at, ultima_mensagem_em)
      values (v_empresa, v_canal, v_c4, 'aberta', v_last - interval '10 minutes', v_last)
      returning id into v_conv;

    insert into public.mensagens (empresa_id, conversa_id, direcao, conteudo, status, created_at) values
      (v_empresa, v_conv, 'entrada', 'Boa tarde, quais documentos preciso enviar?', 'recebida', v_last - interval '10 minutes'),
      (v_empresa, v_conv, 'saida',   'Boa tarde! Preciso de RG ou CNH, comprovante de residência e o último extrato do benefício.', 'lida', v_last - interval '6 minutes'),
      (v_empresa, v_conv, 'entrada', 'Vou separar e te mando.', 'recebida', v_last - interval '2 minutes'),
      (v_empresa, v_conv, 'saida',   'Perfeito, fico no aguardo!', 'entregue', v_last);
  end if;

  raise notice 'Seed de conversas concluído para a empresa %.', v_empresa;
end $$;
