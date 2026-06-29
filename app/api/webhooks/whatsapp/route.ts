import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizarWhatsApp } from "@/lib/telefone";
import {
  extrairMidiaWebhook,
  persistirMidiaRecebida,
  type TipoMensagemDb,
} from "@/lib/whatsapp/midia";

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
        .select("id, empresa_id, access_token")
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
        await processarMensagens(
          admin,
          canal.empresa_id,
          canal.id,
          (canal.access_token as string | null) ?? null,
          value,
        );
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
  accessToken: string | null,
  value: MetaChangeValue,
) {
  // Mapa wa_id -> nome do perfil (vem em value.contacts, paralelo a messages).
  const nomePorWaId = new Map<string, string>();
  for (const c of value.contacts ?? []) {
    if (c.wa_id && c.profile?.name) nomePorWaId.set(c.wa_id, c.profile.name);
  }

  for (const msg of value.messages ?? []) {
    const metaId = msg.id;
    const waId = msg.from; // telefone do cliente em dígitos com DDI (cru do Meta).
    if (!waId) continue;
    // Canoniza para o MESMO formato do funil (13 díg com o nono dígito p/ celular
    // BR). O `wa_id` de celular costuma chegar SEM o 9; sem isso, o webhook criaria
    // um contato divergente do criado manualmente.
    const telefoneCanonico = normalizarWhatsApp(waId);

    // IDEMPOTÊNCIA: o Meta REENTREGA o mesmo webhook se não receber 200 rápido,
    // então o mesmo meta_message_id (wamid) pode chegar 2x. Sem unique em
    // meta_message_id (decisão: não criamos constraint aqui — seria banco/seu
    // lado), o pré-select abaixo cobre o caso comum (reentregas sequenciais):
    // se já gravamos essa mensagem, pula. O INSERT mais abaixo ainda tolera o
    // 23505 caso uma unique em meta_message_id passe a existir no futuro.
    if (metaId) {
      const { data: jaExiste } = await admin
        .from("mensagens")
        .select("id")
        .eq("meta_message_id", metaId)
        .limit(1)
        .maybeSingle();
      if (jaExiste) continue;
    }

    // Conteúdo e metadados de mídia (texto inalterado; mídia → download Meta +
    // upload Storage no passo 2 da feature).
    const extraido = extrairMidiaWebhook(msg);
    let tipo: TipoMensagemDb = extraido.tipo;
    let conteudo: string | null = extraido.conteudo;
    let mediaUrl: string | null = null;
    let mediaMime: string | null = null;
    let mediaNome: string | null = extraido.filename;
    let mediaTamanho: number | null = null;

    // created_at a partir do timestamp do Meta (unix em segundos), se vier.
    const createdAt = msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    // Acha o contato pelo telefone DENTRO da empresa do canal; cria se faltar.
    const contatoId = await acharOuCriarContato(
      admin,
      empresaId,
      canalId,
      telefoneCanonico,
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

    if (extraido.ehMidia) {
      if (accessToken && extraido.mediaId) {
        const midia = await persistirMidiaRecebida(
          admin,
          accessToken,
          empresaId,
          conversaId,
          extraido,
        );
        mediaUrl = midia.mediaUrl;
        mediaMime = midia.mediaMime;
        mediaNome = midia.mediaNome;
        mediaTamanho = midia.mediaTamanho;
        conteudo = midia.conteudo;
      } else {
        if (!accessToken) {
          console.error(
            `[whatsapp:webhook] mídia sem access_token (empresa=${empresaId})`,
          );
        }
        conteudo =
          extraido.caption?.trim() ||
          (extraido.mediaId ? "[mídia não baixada]" : "[mídia sem id]");
        mediaMime = extraido.mimeType;
      }
    }

    // Insere a mensagem de ENTRADA.
    const { error: msgError } = await admin.from("mensagens").insert({
      empresa_id: empresaId,
      conversa_id: conversaId,
      direcao: "entrada",
      tipo,
      conteudo,
      media_url: mediaUrl,
      media_mime: mediaMime,
      media_nome: mediaNome,
      media_tamanho: mediaTamanho,
      status: "recebida",
      meta_message_id: metaId ?? null,
      created_at: createdAt,
    });

    if (msgError) {
      // 23505 (unique_violation) só ocorreria se uma unique em meta_message_id
      // existisse: nesse caso é uma reentrega já gravada -> ignora silenciosamente.
      // Qualquer outro erro: loga e segue sem renovar a janela (não persistiu).
      if (msgError.code !== "23505") {
        console.error(
          `[whatsapp:webhook] falha ao inserir mensagem (empresa=${empresaId}): ${msgError.message}`,
        );
      }
      continue;
    }

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
//
// Anti-regressão: um único UPDATE com .in('status', [...]) — só aplica se o
// status ATUAL estiver na lista de pré-requisitos do novo. Evita race read→write
// e impede delivered atrasado rebaixar 'lida' → 'entregue'.
const STATUS_ANTERIORES: Record<string, string[]> = {
  enviada: ["enviada"],
  entregue: ["enviada"],
  lida: ["enviada", "entregue"],
  // Terminal: só a partir de 'enviada' (não rebaixa lida/entregue para falhou).
  falhou: ["enviada"],
};

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

    const anteriores = STATUS_ANTERIORES[novo];
    if (!anteriores) continue;

    const { data, error } = await admin
      .from("mensagens")
      .update({ status: novo })
      .eq("meta_message_id", st.id)
      .eq("empresa_id", empresaId)
      .in("status", anteriores)
      .select("id");

    if (error) {
      console.error(
        `[whatsapp:webhook] status update falhou (wamid=${st.id}, meta=${st.status}, novo=${novo}, empresa=${empresaId}): ${error.message}`,
      );
      continue;
    }

    const afetadas = data?.length ?? 0;
    if (afetadas === 0) {
      console.log(
        `[whatsapp:webhook] status ignorado (wamid=${st.id}, meta=${st.status}, novo=${novo}, empresa=${empresaId}): 0 linhas — wamid ausente, regressão bloqueada ou já no estado`,
      );
    }
  }
}

// CONTATO — "acha ou cria" ATÔMICO via UPSERT na unique contatos_empresa_telefone_uniq
// (empresa_id, telefone). O `telefone` JÁ chega canonicalizado em 13 dígitos
// (normalizarWhatsApp no chamador), casando com o formato da constraint.
//
// Race condition: quando o Meta dispara várias mensagens do mesmo número em
// paralelo, vários requests tentam criar o mesmo contato. Com o UPSERT, só um
// INSERT vence; os demais caem em DO NOTHING (ignoreDuplicates) em vez de
// estourar 23505. Depois SEMPRE recuperamos o id pela chave canônica — seja a
// linha recém-criada ou a pré-existente.
//
// ignoreDuplicates (DO NOTHING) de propósito: NÃO sobrescrevemos nome/canal_id de
// um contato que já existe — uma reentrega sem nome não pode apagar o nome salvo.
async function acharOuCriarContato(
  admin: Admin,
  empresaId: string,
  canalId: string,
  telefone: string,
  nome: string | null,
): Promise<string | null> {
  const { error: upsertError } = await admin
    .from("contatos")
    .upsert(
      {
        empresa_id: empresaId,
        canal_id: canalId,
        nome,
        telefone,
      },
      { onConflict: "empresa_id,telefone", ignoreDuplicates: true },
    );

  if (upsertError) {
    // Não retornamos já: o select abaixo ainda pode achar a linha (ex.: corrida).
    console.error(
      `[whatsapp:webhook] upsert de contato falhou (empresa=${empresaId}): ${upsertError.message}`,
    );
  }

  // Recupera o id pela chave única canônica (novo OU pré-existente).
  const { data, error } = await admin
    .from("contatos")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("telefone", telefone)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error(
      `[whatsapp:webhook] não recuperou contato (empresa=${empresaId}): ${
        error?.message ?? "sem dados"
      }`,
    );
    return null;
  }
  return data.id as string;
}

// Seleciona a conversa ABERTA do contato (respeita o partial unique index
// conversas_contato_aberta_uniq: no máx. UMA 'aberta' por contato, sem escopo de
// canal). Retorna null se não houver nenhuma aberta.
async function selecionarConversaAberta(
  admin: Admin,
  empresaId: string,
  contatoId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("conversas")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("contato_id", contatoId)
    .eq("status", "aberta")
    .limit(1)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

// CONVERSA — garante no máximo UMA conversa 'aberta' por contato.
//
// NÃO uso upsert/onConflict aqui: o supabase-js mapeia onConflict para uma
// constraint/índice COMPLETO, e a nossa unicidade é um PARTIAL index (WHERE
// status = 'aberta'), que o onConflict não endereça de forma confiável. Então a
// abordagem é: (1) procura a aberta; (2) se não houver, tenta inserir; (3) se a
// inserção bater no partial unique index por uma corrida (Postgres 23505 =
// unique_violation), re-seleciona a aberta que o request concorrente acabou de
// criar — em vez de propagar o erro.
async function acharOuCriarConversa(
  admin: Admin,
  empresaId: string,
  canalId: string,
  contatoId: string,
): Promise<string | null> {
  const existente = await selecionarConversaAberta(admin, empresaId, contatoId);
  if (existente) return existente;

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

  if (!error && criada) return criada.id as string;

  // Corrida: outro request criou a 'aberta' no mesmo instante e o partial unique
  // index rejeitou esta inserção. Recupera a conversa vencedora.
  if (error?.code === "23505") {
    const reSelecionada = await selecionarConversaAberta(
      admin,
      empresaId,
      contatoId,
    );
    if (reSelecionada) return reSelecionada;
  }

  console.error(
    `[whatsapp:webhook] falha ao criar conversa (empresa=${empresaId}): ${
      error?.message ?? "sem dados"
    }`,
  );
  return null;
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
    image?: {
      id?: string;
      mime_type?: string;
      caption?: string;
    };
    audio?: {
      id?: string;
      mime_type?: string;
      voice?: boolean;
    };
    video?: {
      id?: string;
      mime_type?: string;
      caption?: string;
    };
    document?: {
      id?: string;
      mime_type?: string;
      caption?: string;
      filename?: string;
    };
    sticker?: {
      id?: string;
      mime_type?: string;
      animated?: boolean;
    };
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
