import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { telefoneParaArmazenamento } from "@/lib/telefone";
import {
  enviarMensagemMidiaMeta,
  extensaoDeMime,
  removerMidiaStorage,
  subirMidiaParaMeta,
  subirMidiaRecebida,
  validarArquivoMidia,
} from "@/lib/whatsapp/midia";

// POST /api/conversas/[id]/enviar-midia
// Multipart: campo "arquivo" (File) + "legenda" opcional (string).
// Fluxo: valida sessão/RLS → Storage → Meta Media API → Meta messages → INSERT.

export const runtime = "nodejs";

function mensagemParaJson(row: {
  id: string;
  conversa_id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_nome: string | null;
  media_tamanho: number | null;
  status: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    conversaId: row.conversa_id,
    direcao: row.direcao,
    tipo: row.tipo,
    conteudo: row.conteudo ?? "",
    mediaUrl: row.media_url,
    mediaMime: row.media_mime,
    mediaNome: row.media_nome,
    mediaTamanho: row.media_tamanho,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversaId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Formulário inválido." }, { status: 400 });
  }

  const arquivo = form.get("arquivo");
  if (!(arquivo instanceof File) || arquivo.size <= 0) {
    return NextResponse.json({ error: "Arquivo ausente ou vazio." }, { status: 400 });
  }

  const legendaRaw = form.get("legenda");
  const legenda =
    typeof legendaRaw === "string" && legendaRaw.trim()
      ? legendaRaw.trim()
      : null;

  const validacao = validarArquivoMidia(arquivo.type, arquivo.size);
  if (!validacao.ok) {
    return NextResponse.json({ error: validacao.erro }, { status: 400 });
  }

  const { tipo, mime } = validacao;

  const { data: conversa, error: conversaError } = await supabase
    .from("conversas")
    .select(
      "id, empresa_id, canal_id, janela_expira_em, contato:contatos(telefone)",
    )
    .eq("id", conversaId)
    .maybeSingle();

  if (conversaError) {
    return NextResponse.json(
      { error: "Falha ao ler a conversa." },
      { status: 500 },
    );
  }
  if (!conversa) {
    return NextResponse.json(
      { error: "Conversa não encontrada." },
      { status: 404 },
    );
  }

  const janela = conversa.janela_expira_em
    ? new Date(conversa.janela_expira_em as string)
    : null;
  const janelaAberta = janela !== null && janela.getTime() > Date.now();
  if (!janelaAberta) {
    return NextResponse.json(
      {
        error:
          "A janela de 24h está fechada. Mídia só pode ser enviada dentro da janela; fora dela, use um template aprovado.",
        code: "janela_fechada",
      },
      { status: 422 },
    );
  }

  const contato = Array.isArray(conversa.contato)
    ? conversa.contato[0]
    : conversa.contato;
  if (!contato?.telefone) {
    return NextResponse.json(
      { error: "Contato sem telefone para envio." },
      { status: 400 },
    );
  }
  const destino = telefoneParaArmazenamento(contato.telefone);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "Configuração do servidor ausente." },
      { status: 500 },
    );
  }

  let canalQuery = admin
    .from("canais")
    .select("id, phone_number_id, access_token")
    .eq("empresa_id", conversa.empresa_id);

  if (conversa.canal_id) {
    canalQuery = canalQuery.eq("id", conversa.canal_id as string);
  } else {
    canalQuery = canalQuery.eq("tipo", "oficial");
  }

  const { data: canal } = await canalQuery
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!canal?.phone_number_id || !canal.access_token) {
    return NextResponse.json(
      { error: "Nenhum canal de WhatsApp configurado." },
      { status: 400 },
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await arquivo.arrayBuffer();
  } catch {
    return NextResponse.json(
      { error: "Não foi possível ler o arquivo." },
      { status: 400 },
    );
  }

  const ext = extensaoDeMime(mime);
  const nomeArquivo =
    arquivo.name.trim() || `arquivo.${ext}`;
  const mediaNome = tipo === "documento" ? nomeArquivo : null;

  const storage = await subirMidiaRecebida(
    admin,
    conversa.empresa_id as string,
    conversaId,
    bytes,
    mime,
  );

  if (!storage) {
    return NextResponse.json(
      { error: "Não foi possível salvar o arquivo." },
      { status: 500 },
    );
  }

  const mediaId = await subirMidiaParaMeta(
    canal.access_token,
    canal.phone_number_id,
    bytes,
    mime,
    nomeArquivo,
  );

  if (!mediaId) {
    await removerMidiaStorage(admin, storage.path);
    return NextResponse.json(
      {
        error: "Não foi possível enviar a mídia pelo WhatsApp.",
        ...(process.env.NODE_ENV !== "production"
          ? { detail: "Falha no upload para a Media API do Meta." }
          : {}),
      },
      { status: 502 },
    );
  }

  const caption = tipo !== "audio" ? legenda : null;

  const envio = await enviarMensagemMidiaMeta({
    accessToken: canal.access_token,
    phoneNumberId: canal.phone_number_id,
    destino,
    tipo,
    mediaId,
    caption,
    filename: mediaNome,
  });

  if (!envio.ok) {
    await removerMidiaStorage(admin, storage.path);
    console.error(
      `[whatsapp:midia] envio falhou (conversa=${conversaId}): ${envio.erro}`,
    );
    return NextResponse.json(
      {
        error: "Não foi possível enviar a mídia pelo WhatsApp.",
        ...(process.env.NODE_ENV !== "production"
          ? { detail: envio.erro }
          : {}),
      },
      { status: 502 },
    );
  }

  const wamid = envio.wamid;
  const conteudo = caption ?? "";

  const { data: msg, error: insertError } = await supabase
    .from("mensagens")
    .insert({
      empresa_id: conversa.empresa_id,
      conversa_id: conversaId,
      direcao: "saida",
      tipo,
      conteudo,
      media_url: storage.path,
      media_mime: mime,
      media_nome: mediaNome,
      media_tamanho: storage.size,
      status: "enviada",
      meta_message_id: wamid,
    })
    .select(
      "id, conversa_id, direcao, tipo, conteudo, media_url, media_mime, media_nome, media_tamanho, status, created_at",
    )
    .single();

  if (insertError || !msg) {
    console.error(
      `[whatsapp:midia] enviada no Meta (wamid=${wamid}) mas falhou ao salvar (conversa=${conversaId}): ${
        insertError?.message ?? "sem dados"
      }`,
    );
    return NextResponse.json(
      { error: "Mídia enviada, mas falhou ao registrar." },
      { status: 500 },
    );
  }

  await supabase
    .from("conversas")
    .update({ ultima_mensagem_em: msg.created_at })
    .eq("id", conversaId);

  return NextResponse.json(
    { mensagem: mensagemParaJson(msg), wamid },
    { status: 201 },
  );
}
