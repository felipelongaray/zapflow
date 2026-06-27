-- =============================================================================
-- ZapFlow — Estrutura para a integração oficial do WhatsApp (Cloud API)
-- =============================================================================
-- Modela duas regras centrais da Cloud API:
--   (1) JANELA DE 24h — após a ÚLTIMA mensagem RECEBIDA do cliente (direcao
--       'entrada'), há 24h para enviar TEXTO LIVRE. Fora da janela, só TEMPLATES
--       aprovados (HSM). Guardamos o instante de expiração por conversa.
--   (2) TEMPLATES (HSM) — mensagens pré-aprovadas pelo Meta, por empresa.
--
-- Aqui só criamos a ESTRUTURA. A lógica (atualizar a janela ao receber mensagem,
-- bloquear texto livre fora dela, sincronizar status com o Meta) vem depois.
--
-- Esta migration NÃO deve ser executada automaticamente. Revise e rode manual.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. CONVERSAS — instante de expiração da janela de 24h
-- ----------------------------------------------------------------------------
-- NULLABLE de propósito: uma conversa pode nunca ter recebido uma 'entrada'
-- (ex.: criada para um primeiro contato ativo via template) — nesse caso não há
-- janela aberta. A aplicação setará janela_expira_em = now() + interval '24h'
-- a cada mensagem de entrada; o "está dentro da janela?" é simplesmente
-- (janela_expira_em is not null and janela_expira_em > now()).
alter table public.conversas
  add column if not exists janela_expira_em timestamptz;

-- ----------------------------------------------------------------------------
-- 2. TEMPLATES (HSM aprovados pelo Meta, por empresa)
-- ----------------------------------------------------------------------------
create table if not exists public.templates (
  id               uuid        primary key default gen_random_uuid(),
  empresa_id       uuid        not null references public.empresas (id) on delete cascade,
  nome             text        not null,                          -- nome no Meta (ex: 'boas_vindas')
  categoria        text        not null check (categoria in ('marketing', 'utility', 'authentication')),
  idioma           text        not null default 'pt_BR',
  corpo            text        not null,                          -- texto com variáveis {{1}}, {{2}}...
  status           text        not null default 'pendente' check (status in ('aprovado', 'pendente', 'rejeitado')),
  meta_template_id text,                                          -- id no Meta (sync futuro)
  created_at       timestamptz not null default now()
);

create index if not exists templates_empresa_id_idx on public.templates (empresa_id);

-- Um mesmo template (nome + idioma) é único dentro da empresa. Empresas
-- diferentes podem ter o mesmo nome de template sem conflito.
create unique index if not exists templates_empresa_nome_idioma_uniq
  on public.templates (empresa_id, nome, idioma);

-- ----------------------------------------------------------------------------
-- 3. MENSAGENS — vínculo opcional ao template usado
-- ----------------------------------------------------------------------------
-- Preenchido só quando a mensagem enviada foi um TEMPLATE; NULL para texto
-- livre. on delete set null: apagar um template não apaga o histórico de
-- mensagens — apenas desfaz a referência.
alter table public.mensagens
  add column if not exists template_id uuid
  references public.templates (id) on delete set null;

create index if not exists mensagens_template_id_idx on public.mensagens (template_id);

-- ----------------------------------------------------------------------------
-- 4. RLS + GRANTS em templates
-- ----------------------------------------------------------------------------
-- Padrão multi-tenant das demais tabelas, com uma trava extra de papel na
-- ESCRITA (mesma ideia das etapas, migration 008):
--   - SELECT: qualquer usuário da empresa (dono E atendente) — o atendente
--     precisa LER os templates para enviá-los fora da janela de 24h.
--   - INSERT/UPDATE/DELETE: só o DONO da empresa (sou_dono_da_empresa()).
--     Gerenciar o catálogo de templates é decisão do dono; o atendente apenas
--     usa. A trava real é aqui no banco — esconder o botão no front é só UX.
--   - Superadmin sempre pode (gestão do sistema).
-- O WITH CHECK replica a condição para impedir criar/mover template para outra
-- empresa (anti-cross-tenant).
alter table public.templates enable row level security;

drop policy if exists templates_select on public.templates;
create policy templates_select on public.templates
  for select to authenticated
  using (
    public.sou_super_admin()
    or empresa_id = public.get_minha_empresa()
  );

drop policy if exists templates_insert on public.templates;
create policy templates_insert on public.templates
  for insert to authenticated
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists templates_update on public.templates;
create policy templates_update on public.templates
  for update to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  )
  with check (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

drop policy if exists templates_delete on public.templates;
create policy templates_delete on public.templates
  for delete to authenticated
  using (
    public.sou_super_admin()
    or (empresa_id = public.get_minha_empresa() and public.sou_dono_da_empresa())
  );

-- GRANTs: authenticated opera sob RLS; service_role para o backend confiável
-- (ex.: sincronizar status/ids dos templates com o Meta no futuro).
grant select, insert, update, delete on public.templates to authenticated, service_role;
