-- =============================================================================
-- ZapFlow — Colunas de mídia em mensagens (passo 1 da feature de mídia)
-- =============================================================================
-- Prepara a tabela mensagens para armazenar metadados de mídia (imagem, áudio,
-- vídeo, documento, sticker). O arquivo em si ficará no Supabase Storage
-- (bucket privado, criado manualmente no painel — NÃO criamos bucket aqui).
--
-- conteudo: continua existindo; para mensagens de mídia passará a guardar a
-- LEGENDA (caption), quando houver. Para texto puro, segue sendo o corpo.
--
-- media_url: PATH interno no Storage (ex: {empresa_id}/{conversa_id}/{uuid}.jpg).
--            NÃO é URL pública — a exibição usará signed URLs geradas no servidor
--            (passos 3/4 da feature, ainda não implementados).
--
-- Esta migration NÃO altera RLS, GRANTs nem helpers SECURITY DEFINER. As colunas
-- novas são cobertas pelas policies existentes de mensagens (filtro por
-- empresa_id). Não cria bucket de Storage.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. tipo — classifica a mensagem (texto ou mídia)
-- ----------------------------------------------------------------------------
-- NOT NULL + DEFAULT 'texto': ao adicionar a coluna, o Postgres preenche TODAS
-- as linhas existentes automaticamente com 'texto' — mensagens antigas viram
-- 'texto' sem UPDATE explícito. O backfill abaixo é redundante/idempotente, só
-- por segurança caso a coluna já existisse nullable de um run parcial anterior.
alter table public.mensagens
  add column if not exists tipo text not null default 'texto';

update public.mensagens
   set tipo = 'texto'
 where tipo is null;

alter table public.mensagens drop constraint if exists mensagens_tipo_check;
alter table public.mensagens
  add constraint mensagens_tipo_check
  check (tipo in ('texto', 'imagem', 'audio', 'video', 'documento', 'sticker'));

-- ----------------------------------------------------------------------------
-- 2. Metadados de mídia (nullable — mensagens de texto não preenchem)
-- ----------------------------------------------------------------------------
alter table public.mensagens
  add column if not exists media_url text;

alter table public.mensagens
  add column if not exists media_mime text;

alter table public.mensagens
  add column if not exists media_nome text;

alter table public.mensagens
  add column if not exists media_tamanho bigint;

-- Comentários de documentação (não alteram comportamento).
comment on column public.mensagens.tipo is
  'Tipo da mensagem: texto, imagem, audio, video, documento ou sticker. Default texto.';

comment on column public.mensagens.media_url is
  'Path interno no Supabase Storage (bucket privado). NÃO é URL pública; signed URL no servidor.';

comment on column public.mensagens.media_mime is
  'MIME type do arquivo (ex: image/jpeg, audio/ogg).';

comment on column public.mensagens.media_nome is
  'Nome original do arquivo (relevante para documento).';

comment on column public.mensagens.media_tamanho is
  'Tamanho do arquivo em bytes.';
