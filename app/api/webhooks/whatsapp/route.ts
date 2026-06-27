import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

// Webhook do WhatsApp Cloud API (Meta).
//   GET  -> handshake de verificação do webhook (hub.challenge).
//   POST -> recebimento de eventos (mensagens recebidas e callbacks de status).
//
// node:crypto exige runtime Node (não Edge). force-dynamic: nunca cachear.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Variáveis de ambiente necessárias (server-only, sem NEXT_PUBLIC_):
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN — token GLOBAL do handshake do app (GET).
//   WHATSAPP_APP_SECRET           — App Secret do Meta, para validar a assinatura.

// ===========================================================================
// PARTE 1 — GET: verificação/handshake
// ===========================================================================
// O Meta chama GET com hub.mode, hub.verify_token e hub.challenge. Se o modo for
// 'subscribe' e o token bater com o verify_token GLOBAL do app, devolvemos o
// challenge em texto puro. Usamos um token global (não o por-canal) porque o
// webhook é configurado por APP no Meta, não por número; o roteamento por
// empresa acontece no POST, via phone_number_id do payload.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const esperado = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && esperado && token === esperado) {
    return new Response(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("Forbidden", { status: 403 });
}

// ===========================================================================
// PARTE 2 — POST: recebimento de eventos
// ===========================================================================
export async function POST(request: Request) {
  // IMPORTANTE: ler o corpo BRUTO (raw). O HMAC do Meta é calculado sobre os
  // bytes exatos enviados; reserializar o JSON parseado mudaria o conteúdo e a
  // assinatura nunca bateria.
  const raw = await request.text();
  const assinatura = request.headers.get("x-hub-signature-256");

  if (!assinaturaValida(raw, assinatura)) {
    // Assinatura ausente/incorreta: pode ser requisição forjada. Não processa.
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Processa de forma resiliente: erros por item são logados, mas SEMPRE
  // respondemos 200 ao Meta (senão ele reentrega em loop). A assinatura já
  // garantiu a autenticidade da chamada.
  try {
    await processar(payload);
  } catch (e) {
    console.error(
      `[whatsapp:webhook] erro ao processar: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

// ---------------------------------------------------------------------------
// Validação de assinatura (HMAC SHA256 do corpo bruto com o App Secret)
// ---------------------------------------------------------------------------
function assinaturaValida(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header) return false;

  const esperado =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");

  // Comparação em tempo constante. timingSafeEqual exige buffers de mesmo
  // tamanho, então checamos o comprimento antes (e isso não vaza o segredo).
  const a = Buffer.from(header);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Processamento dos eventos
// ---------------------------------------------------------------------------
async function processar(payload: MetaWebhookPayload) {
  const admin = createAdminClient();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      // phone_number_id roteia o evento para o CANAL — e portanto para a EMPRESA.
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const { data: canal } = await admin
        .from("canais")
        .select("id, empresa_id")
        .eq("phone_number_id", phoneNumberId)
        .limit(1)
        .maybeSingle();

      if (!canal) {
        // Nenhum canal cadastrado com esse phone_number_id: ignora (não é nosso).
        console.error(
          `[whatsapp:webhook] phone_number_id sem canal: ${phoneNumberId}`,
        );
        continue;
      }

      if (value.messages?.length) {
        await processarMensagens(admin, canal.empresa_id, canal.id, value);
      }
      if (value.statuses?.length) {
        await processarStatuses(admin, canal.empresa_id, value);
      }
    }
  }
}

type Admin = ReturnType<typeof createAdminClient>;

// Mensagens RECEBIDAS do cliente (direcao 'entrada').
async function processarMensagens(
  admin: Admin,
  empresaId: string,
  canalId: string,
  value: MetaChangeValue,
) {
  // Mapa wa_id -> nome do perfil (vem em value.contacts, paralelo a messages).
  const nomePorWaId = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.profile?.name) nomePorWaId.set(c.wa_id, c.profile.name);
  }

  for (const msg of value.messages ?? []) {
    const metaId = msg.id;
    const waId = msg.from; // telefone do cliente em dígitos com DDI.
    if (!waId) continue;

    // IDEMPOTÊNCIA: o Meta pode reentregar. Se já temos essa mensagem, pula.
    if (metaId) {
      const { data: jaExiste } = await admin
        .from("mensagens")
        .select("id")
        .eq("meta_message_id", metaId)
        .limit(1)
        .maybeSingle();
      if (jaExiste) continue;
    }

    // Conteúdo: hoje tratamos texto; outros tipos viram um marcador legível.
    const conteudo =
      msg.type === "text" && msg.text?.body
        ? msg.text.body
        : `[${msg.type ?? "mensagem"}]`;

    // created_at a partir do timestamp do Meta (unix em segundos), se vier.
    const createdAt = msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    // Acha o contato pelo telefone DENTRO da empresa do canal; cria se faltar.
    const contatoId = await acharOuCriarContato(
      admin,
      empresaId,
      canalId,
      waId,
      nomePorWaId.get(waId) ?? null,
    );
    if (!contatoId) continue;

    // Acha a conversa (contato + canal) na empresa; cria se faltar.
    const conversaId = await acharOuCriarConversa(
      admin,
      empresaId,
      canalId,
      contatoId,
    );
    if (!conversaId) continue;

    // Insere a mensagem de ENTRADA.
    await admin.from("mensagens").insert({
      empresa_id: empresaId,
      conversa_id: conversaId,
      direcao: "entrada",
      conteudo,
      status: "recebida",
      meta_message_id: metaId ?? null,
      created_at: createdAt,
    });

    // REGRA DA JANELA: uma mensagem de ENTRADA abre/renova a janela de 24h.
    // Também atualiza a ordenação da lista de conversas.
    await admin
      .from("conversas")
      .update({
        janela_expira_em: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ultima_mensagem_em: createdAt,
      })
      .eq("id", conversaId);
  }
}

// Callbacks de STATUS (sent/delivered/read/failed) das mensagens que enviamos.
async function processarStatuses(
  admin: Admin,
  empresaId: string,
  value: MetaChangeValue,
) {
  const mapa: Record<string, string> = {
    sent: "enviada",
    delivered: "entregue",
    read: "lida",
    failed: "falhou",
  };

  for (const st of value.statuses ?? []) {
    const novo = mapa[st.status ?? ""];
    if (!st.id || !novo) continue;

    // Casa pelo meta_message_id (wamid) e escopa pela empresa do canal.
    await admin
      .from("mensagens")
      .update({ status: novo })
      .eq("meta_message_id", st.id)
      .eq("empresa_id", empresaId);
  }
}

async function acharOuCriarContato(
  admin: Admin,
  empresaId: string,
  canalId: string,
  telefone: string,
  nome: string | null,
): Promise<string | null> {
  const { data: existente } = await admin
    .from("contatos")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("telefone", telefone)
    .limit(1)
    .maybeSingle();

  if (existente) return existente.id as string;

  const { data: criado, error } = await admin
    .from("contatos")
    .insert({
      empresa_id: empresaId,
      canal_id: canalId,
      nome,
      telefone,
    })
    .select("id")
    .single();

  if (error || !criado) {
    console.error(
      `[whatsapp:webhook] falha ao criar contato (empresa=${empresaId}): ${
        error?.message ?? "sem dados"
      }`,
    );
    return null;
  }
  return criado.id as string;
}

async function acharOuCriarConversa(
  admin: Admin,
  empresaId: string,
  canalId: string,
  contatoId: string,
): Promise<string | null> {
  const { data: existente } = await admin
    .from("conversas")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("canal_id", canalId)
    .eq("contato_id", contatoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existente) return existente.id as string;

  const { data: criada, error } = await admin
    .from("conversas")
    .insert({
      empresa_id: empresaId,
      canal_id: canalId,
      contato_id: contatoId,
      status: "aberta",
    })
    .select("id")
    .single();

  if (error || !criada) {
    console.error(
      `[whatsapp:webhook] falha ao criar conversa (empresa=${empresaId}): ${
        error?.message ?? "sem dados"
      }`,
    );
    return null;
  }
  return criada.id as string;
}

// ---------------------------------------------------------------------------
// Tipos mínimos do payload do Meta (só o que usamos).
// ---------------------------------------------------------------------------
type MetaWebhookPayload = {
  entry?: {
    changes?: {
      value?: MetaChangeValue;
    }[];
  }[];
};

type MetaChangeValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: {
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }[];
  statuses?: { id?: string; status?: string }[];
};

// ===========================================================================
// SEGURANÇA — resumo
// ===========================================================================
// (a) ASSINATURA: validamos X-Hub-Signature-256 = HMAC-SHA256(corpo bruto,
//     App Secret). Só quem tem o App Secret consegue forjar um header válido;
//     uma requisição falsa (sem o segredo) é rejeitada com 401 antes de tocar
//     no banco. Comparação em tempo constante evita timing attacks.
// (b) ROTEAMENTO POR EMPRESA: metadata.phone_number_id identifica o número que
//     recebeu o evento; achamos o canal por esse id e dele tiramos o empresa_id.
//     Todas as escritas são escopadas a essa empresa — sem cross-tenant.
// (c) JANELA 24h: toda mensagem de ENTRADA seta janela_expira_em = now() + 24h,
//     abrindo/renovando a janela em que o envio de texto livre é permitido.
//
// service_role: o webhook é o Meta chamando, sem sessão de usuário. Por isso as
// escritas usam o cliente admin (ignora RLS), sempre com o empresa_id correto.
// Nenhum segredo é retornado nas respostas.
// ===========================================================================
