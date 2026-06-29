import "server-only";

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKET_MIDIA_MENSAGENS = "midia-mensagens";
export const GRAPH_VERSION = "v21.0";

export type TipoMensagemDb =
  | "texto"
  | "imagem"
  | "audio"
  | "video"
  | "documento"
  | "sticker";

type MetaMediaBlock = {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
};

export type MetaMensagemRecebida = {
  type?: string;
  text?: { body?: string };
  image?: MetaMediaBlock;
  audio?: MetaMediaBlock;
  video?: MetaMediaBlock;
  document?: MetaMediaBlock;
  sticker?: MetaMediaBlock;
};

export type MidiaWebhookExtraida = {
  tipo: TipoMensagemDb;
  ehMidia: boolean;
  mediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  conteudo: string | null;
};

const MAPA_TIPO_META: Record<string, TipoMensagemDb> = {
  text: "texto",
  image: "imagem",
  audio: "audio",
  video: "video",
  document: "documento",
  sticker: "sticker",
};

/** Meta Cloud API type → coluna mensagens.tipo (CHECK da migration 017). */
export function mapearTipoMeta(metaType: string | undefined): TipoMensagemDb {
  return MAPA_TIPO_META[metaType ?? ""] ?? "texto";
}

export type TipoMidiaEnvio = "imagem" | "audio" | "video" | "documento";

/** Limites conservadores (bytes) alinhados ao Meta Cloud API. */
export const LIMITES_TAMANHO_MIDIA: Record<TipoMidiaEnvio, number> = {
  imagem: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  documento: 100 * 1024 * 1024,
};

const MIMES_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIMES_VIDEO = new Set(["video/mp4", "video/3gpp"]);
const MIMES_AUDIO = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
]);
const MIMES_DOCUMENTO = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

function normalizarMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** Valida MIME e tamanho de arquivo de envio. Usado no servidor (fonte da verdade). */
export function validarArquivoMidia(
  mimeType: string,
  tamanho: number,
): { ok: true; tipo: TipoMidiaEnvio; mime: string } | { ok: false; erro: string } {
  const mime = normalizarMime(mimeType);

  let tipo: TipoMidiaEnvio | null = null;
  if (MIMES_IMAGEM.has(mime)) tipo = "imagem";
  else if (MIMES_VIDEO.has(mime)) tipo = "video";
  else if (MIMES_AUDIO.has(mime)) tipo = "audio";
  else if (MIMES_DOCUMENTO.has(mime)) tipo = "documento";

  if (!tipo) {
    return {
      ok: false,
      erro: "Tipo de arquivo não suportado. Envie imagem, vídeo, áudio ou documento.",
    };
  }

  const limite = LIMITES_TAMANHO_MIDIA[tipo];
  if (tamanho > limite) {
    const mb = Math.round(limite / (1024 * 1024));
    return {
      ok: false,
      erro: `Arquivo muito grande. O limite para ${tipo} é ${mb} MB.`,
    };
  }

  if (tamanho <= 0) {
    return { ok: false, erro: "Arquivo vazio." };
  }

  return { ok: true, tipo, mime };
}

export function tipoMidiaParaMeta(tipo: TipoMidiaEnvio): "image" | "video" | "audio" | "document" {
  const mapa: Record<TipoMidiaEnvio, "image" | "video" | "audio" | "document"> = {
    imagem: "image",
    video: "video",
    audio: "audio",
    documento: "document",
  };
  return mapa[tipo];
}

/** Remove arquivo do Storage (best-effort, para rollback em falha no Meta). */
export async function removerMidiaStorage(
  admin: SupabaseClient,
  path: string,
): Promise<void> {
  const { error } = await admin.storage.from(BUCKET_MIDIA_MENSAGENS).remove([path]);
  if (error) {
    console.error(
      `[whatsapp:midia] falha ao remover do Storage (path=${path}): ${error.message}`,
    );
  }
}

/** Upload na Media API do Meta → retorna media_id ou null. */
export async function subirMidiaParaMeta(
  accessToken: string,
  phoneNumberId: string,
  bytes: ArrayBuffer,
  mimeType: string,
  filename: string,
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: mimeType }),
      filename,
    );
    form.append("type", mimeType);
    form.append("messaging_product", "whatsapp");

    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      },
    );

    const json = (await resp.json()) as { id?: string; error?: { message?: string } };

    if (!resp.ok || !json.id) {
      console.error(
        `[whatsapp:midia] upload Meta falhou: ${json.error?.message ?? `HTTP ${resp.status}`}`,
      );
      return null;
    }

    return json.id;
  } catch (e) {
    console.error(
      `[whatsapp:midia] erro no upload Meta: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

type EnvioMidiaMetaParams = {
  accessToken: string;
  phoneNumberId: string;
  destino: string;
  tipo: TipoMidiaEnvio;
  mediaId: string;
  caption: string | null;
  filename: string | null;
};

/** Envia mensagem de mídia referenciando media_id do Meta. */
export async function enviarMensagemMidiaMeta(
  params: EnvioMidiaMetaParams,
): Promise<{ ok: true; wamid: string | null } | { ok: false; erro: string }> {
  const metaTipo = tipoMidiaParaMeta(params.tipo);
  const bloco: Record<string, unknown> = { id: params.mediaId };

  if (params.caption && params.tipo !== "audio") {
    bloco.caption = params.caption;
  }
  if (params.tipo === "documento" && params.filename) {
    bloco.filename = params.filename;
  }

  const payload = {
    messaging_product: "whatsapp",
    to: params.destino,
    type: metaTipo,
    [metaTipo]: bloco,
  };

  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${params.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const json = (await resp.json()) as {
      messages?: { id?: string }[];
      error?: { message?: string };
    };

    if (!resp.ok) {
      const detalhe = json.error?.message ?? `HTTP ${resp.status}`;
      console.error(`[whatsapp:midia] envio mensagem Meta falhou: ${detalhe}`);
      return { ok: false, erro: detalhe };
    }

    return { ok: true, wamid: json.messages?.[0]?.id ?? null };
  } catch (e) {
    console.error(
      `[whatsapp:midia] erro de rede ao enviar mensagem: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { ok: false, erro: "Falha de conexão com o WhatsApp." };
  }
}

/** Deriva extensão de arquivo a partir do MIME type (fallback: 'bin'). */
export function extensaoDeMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "bin";

  const base = mimeType.split(";")[0].trim().toLowerCase();
  const mapa: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };

  if (mapa[base]) return mapa[base];

  const sufixo = base.split("/")[1];
  if (sufixo && /^[a-z0-9+.]+$/.test(sufixo)) {
    return sufixo.replace("+", "_");
  }
  return "bin";
}

/** Extrai tipo, media id, caption e filename do payload de mensagem do Meta. */
export function extrairMidiaWebhook(msg: MetaMensagemRecebida): MidiaWebhookExtraida {
  const metaType = msg.type ?? "text";

  if (metaType === "text") {
    return {
      tipo: "texto",
      ehMidia: false,
      mediaId: null,
      mimeType: null,
      caption: null,
      filename: null,
      conteudo: msg.text?.body ?? "",
    };
  }

  const bloco =
    metaType === "image"
      ? msg.image
      : metaType === "audio"
        ? msg.audio
        : metaType === "video"
          ? msg.video
          : metaType === "document"
            ? msg.document
            : metaType === "sticker"
              ? msg.sticker
              : undefined;

  const tipo = mapearTipoMeta(metaType);
  const ehMidia = MAPA_TIPO_META[metaType] !== undefined && metaType !== "text";

  if (!ehMidia || !bloco) {
    return {
      tipo: "texto",
      ehMidia: false,
      mediaId: null,
      mimeType: null,
      caption: null,
      filename: null,
      conteudo: `[${metaType}]`,
    };
  }

  return {
    tipo,
    ehMidia: true,
    mediaId: bloco.id ?? null,
    mimeType: bloco.mime_type ?? null,
    caption: bloco.caption ?? null,
    filename: metaType === "document" ? (bloco.filename ?? null) : null,
    conteudo: null,
  };
}

type MidiaBaixada = {
  bytes: ArrayBuffer;
  mimeType: string;
  fileSize: number | null;
};

/**
 * Baixa mídia do Meta: (1) GET /{media_id} → url temporária; (2) GET url com
 * Authorization. Retorna null em qualquer falha (não lança).
 */
export async function baixarMidiaDoMeta(
  accessToken: string,
  mediaId: string,
): Promise<MidiaBaixada | null> {
  try {
    const metaResp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!metaResp.ok) {
      console.error(
        `[whatsapp:midia] meta info falhou (media_id=${mediaId}): HTTP ${metaResp.status}`,
      );
      return null;
    }

    const metaJson = (await metaResp.json()) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };

    if (!metaJson.url) {
      console.error(
        `[whatsapp:midia] meta info sem url (media_id=${mediaId})`,
      );
      return null;
    }

    const binResp = await fetch(metaJson.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!binResp.ok) {
      console.error(
        `[whatsapp:midia] download binário falhou (media_id=${mediaId}): HTTP ${binResp.status}`,
      );
      return null;
    }

    const bytes = await binResp.arrayBuffer();
    const mimeType =
      metaJson.mime_type ??
      binResp.headers.get("content-type")?.split(";")[0] ??
      "application/octet-stream";

    return {
      bytes,
      mimeType,
      fileSize: metaJson.file_size ?? bytes.byteLength,
    };
  } catch (e) {
    console.error(
      `[whatsapp:midia] erro ao baixar (media_id=${mediaId}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/**
 * Sobe bytes no bucket privado midia-mensagens. Path =
 * {empresaId}/{conversaId}/{uuid}.{ext} — ids vêm do roteamento interno, nunca
 * do payload do Meta. Retorna o path interno (NÃO URL pública) ou null.
 */
export async function subirMidiaRecebida(
  admin: SupabaseClient,
  empresaId: string,
  conversaId: string,
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<{ path: string; size: number } | null> {
  const ext = extensaoDeMime(mimeType);
  const path = `${empresaId}/${conversaId}/${crypto.randomUUID()}.${ext}`;

  try {
    const { error } = await admin.storage
      .from(BUCKET_MIDIA_MENSAGENS)
      .upload(path, bytes, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      console.error(
        `[whatsapp:midia] upload falhou (path=${path}): ${error.message}`,
      );
      return null;
    }

    return { path, size: bytes.byteLength };
  } catch (e) {
    console.error(
      `[whatsapp:midia] erro no upload (path=${path}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

export type MidiaPersistida = {
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaNome: string | null;
  mediaTamanho: number | null;
  conteudo: string | null;
};

/**
 * Pipeline completo: media_id → URL Meta → download → upload Storage.
 * Em falha, retorna metadados parciais e conteudo de fallback — nunca lança.
 */
export async function persistirMidiaRecebida(
  admin: SupabaseClient,
  accessToken: string,
  empresaId: string,
  conversaId: string,
  extraido: MidiaWebhookExtraida,
): Promise<MidiaPersistida> {
  const caption = extraido.caption?.trim() || null;
  const fallbackConteudo = caption ?? "[mídia não baixada]";

  if (!extraido.mediaId) {
    return {
      mediaUrl: null,
      mediaMime: extraido.mimeType,
      mediaNome: extraido.filename,
      mediaTamanho: null,
      conteudo: fallbackConteudo,
    };
  }

  const baixada = await baixarMidiaDoMeta(accessToken, extraido.mediaId);
  if (!baixada) {
    return {
      mediaUrl: null,
      mediaMime: extraido.mimeType,
      mediaNome: extraido.filename,
      mediaTamanho: null,
      conteudo: fallbackConteudo,
    };
  }

  const enviada = await subirMidiaRecebida(
    admin,
    empresaId,
    conversaId,
    baixada.bytes,
    baixada.mimeType,
  );

  if (!enviada) {
    return {
      mediaUrl: null,
      mediaMime: baixada.mimeType,
      mediaNome: extraido.filename,
      mediaTamanho: baixada.fileSize,
      conteudo: fallbackConteudo,
    };
  }

  return {
    mediaUrl: enviada.path,
    mediaMime: baixada.mimeType,
    mediaNome: extraido.filename,
    mediaTamanho: baixada.fileSize ?? enviada.size,
    conteudo: caption,
  };
}
