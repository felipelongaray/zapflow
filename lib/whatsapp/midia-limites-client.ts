/** Limites de envio (espelham lib/whatsapp/midia.ts — validação real no servidor). */

export type TipoMidiaEnvioClient =
  | "imagem"
  | "audio"
  | "video"
  | "documento";

export const LIMITES_TAMANHO_MIDIA_CLIENT: Record<TipoMidiaEnvioClient, number> =
  {
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

export function validarArquivoMidiaClient(
  file: File,
): { ok: true; tipo: TipoMidiaEnvioClient } | { ok: false; erro: string } {
  const mime = file.type.split(";")[0].trim().toLowerCase();

  let tipo: TipoMidiaEnvioClient | null = null;
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

  const limite = LIMITES_TAMANHO_MIDIA_CLIENT[tipo];
  if (file.size > limite) {
    const mb = Math.round(limite / (1024 * 1024));
    return {
      ok: false,
      erro: `Arquivo muito grande. O limite para ${tipo} é ${mb} MB.`,
    };
  }

  if (file.size <= 0) {
    return { ok: false, erro: "Arquivo vazio." };
  }

  return { ok: true, tipo };
}

export const ACCEPT_MIDIA =
  "image/jpeg,image/png,image/webp,video/mp4,video/3gpp,audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain";
