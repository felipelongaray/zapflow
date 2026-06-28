-- 015: habilita Supabase Realtime na tabela mensagens
-- A publication supabase_realtime já existe (puballtables=false).
-- Adiciona apenas public.mensagens. O RLS da tabela continua valendo:
-- cada cliente só recebe eventos das linhas que poderia ler
-- (empresa_id = get_minha_empresa()). Nenhuma policy é alterada aqui.
alter publication supabase_realtime add table public.mensagens;

-- replica identity full garante que o payload do evento traga a linha completa.
alter table public.mensagens replica identity full;
