import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { telefoneParaArmazenamento } from "@/lib/telefone";

// POST /api/conversas/[id]/enviar
// Envia uma mensagem pela WhatsApp Cloud API (Meta) E persiste no banco.
//
// SEGURANÇA (ver explicação detalhada no fim do arquivo):
//   - Roda SEMPRE no servidor. O access_token do canal NUNCA vai ao browser.
//   - Identifica e autoriza o usuário pela SESSÃO (cliente sob RLS). A conversa
//     só é lida se pertencer à empresa do usuário (RLS faz o isolamento).
//   - As credenciais do canal são lidas NO SERVIDOR via service_role.
//   - A resposta ao cliente nunca inclui o token nem dados sensíveis.

const GRAPH_VERSION = "v21.0";

type Body = {
  conteudo?: string;
  templateId?: string | null;
};

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

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const conteudo = (body.conteudo ?? "").trim();
  const templateId = body.templateId ?? null;
  const ehTemplate = !!templateId;

  if (!conteudo) {
    return NextResponse.json({ error: "Mensagem vazia." }, { status: 400 });
  }

  // -------------------------------------------------------------------------
  // 1. Conversa via cliente de SESSÃO (RLS garante que é da empresa do usuário).
  // -------------------------------------------------------------------------
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
    // Inexistente OU de outra empresa (o RLS esconde): mesma resposta neutra.
    return NextResponse.json(
      { error: "Conversa não encontrada." },
      { status: 404 },
    );
  }

  // -------------------------------------------------------------------------
  // 2. REGRA DA JANELA DE 24h. Texto livre só com janela ABERTA; template passa.
  // -------------------------------------------------------------------------
  if (!ehTemplate) {
    const janela = conversa.janela_expira_em
      ? new Date(conversa.janela_expira_em as string)
      : null;
    const janelaAberta = janela !== null && janela.getTime() > Date.now();
    if (!janelaAberta) {
      return NextResponse.json(
        {
          error:
            "A janela de 24h está fechada. Só é possível enviar um template aprovado.",
          code: "janela_fechada",
        },
        { status: 422 },
      );
    }
  }

  // Telefone do contato, normalizado para dígitos com DDI 55 (formato do Meta).
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

  // -------------------------------------------------------------------------
  // 3. Canal + CREDENCIAIS lidas NO SERVIDOR via service_role (nunca no browser).
  // -------------------------------------------------------------------------
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

  // Usa o canal da conversa, se houver; senão, o primeiro canal oficial.
  if (conversa.canal_id) {
    canalQuery = canalQuery.eq("id", conversa.canal_id as string);
  } else {
    canalQuery = canalQuery.eq("tipo", "oficial");
  }

  const { data: canal } = await canalQuery
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!canal || !canal.phone_number_id || !canal.access_token) {
    return NextResponse.json(
      { error: "Nenhum canal de WhatsApp configurado." },
      { status: 400 },
    );
  }

  // -------------------------------------------------------------------------
  // 4. Monta o payload do Meta. Texto livre OU template (mínimo, p/ o futuro).
  // -------------------------------------------------------------------------
  let payload: Record<string, unknown>;
  if (ehTemplate) {
    // Valida o template no servidor: precisa ser da empresa e estar aprovado.
    const { data: template } = await admin
      .from("templates")
      .select("nome, idioma, status, empresa_id")
      .eq("id", templateId as string)
      .maybeSingle();

    if (
      !template ||
      template.empresa_id !== conversa.empresa_id ||
      template.status !== "aprovado"
    ) {
      return NextResponse.json(
        { error: "Template inválido ou não aprovado." },
        { status: 422 },
      );
    }

    // Envio mínimo (sem variáveis). Quando a UI de template existir, montaremos
    // os `components` com os parâmetros {{1}}, {{2}}... aqui.
    payload = {
      messaging_product: "whatsapp",
      to: destino,
      type: "template",
      template: {
        name: template.nome,
        language: { code: template.idioma },
      },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      to: destino,
      type: "text",
      text: { body: conteudo },
    };
  }

  // -------------------------------------------------------------------------
  // 5. Chama a Graph API. O token vai SÓ no header Authorization, no servidor.
  // -------------------------------------------------------------------------
  let metaJson: {
    messages?: { id?: string }[];
    error?: { message?: string };
  } = {};
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${canal.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${canal.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    metaJson = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // Loga o detalhe do Meta no servidor; ao cliente, mensagem tratada (sem
      // token, que de todo modo nunca aparece na resposta de erro do Meta).
      const metaErro = metaJson?.error?.message ?? `HTTP ${resp.status}`;
      console.error(
        `[whatsapp] envio falhou (conversa=${conversaId}): ${metaErro}`,
      );
      return NextResponse.json(
        {
          error: "Não foi possível enviar pelo WhatsApp.",
          ...(process.env.NODE_ENV !== "production"
            ? { detail: metaErro }
            : {}),
        },
        { status: 502 },
      );
    }
  } catch (e) {
    console.error(
      `[whatsapp] erro de rede ao enviar (conversa=${conversaId}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return NextResponse.json(
      { error: "Falha de conexão com o WhatsApp." },
      { status: 502 },
    );
  }

  // wamid = id da mensagem no Meta. Persistido em mensagens.meta_message_id
  // (migration 014) para depois casar os callbacks de status do webhook.
  const wamid = metaJson?.messages?.[0]?.id ?? null;

  // -------------------------------------------------------------------------
  // 6. Persiste a mensagem (cliente de SESSÃO, sob RLS WITH CHECK). empresa_id
  //    é o da conversa lida sob RLS — nunca um valor vindo do cliente.
  // -------------------------------------------------------------------------
  const { data: msg, error: insertError } = await supabase
    .from("mensagens")
    .insert({
      empresa_id: conversa.empresa_id,
      conversa_id: conversaId,
      direcao: "saida",
      conteudo,
      status: "enviada",
      template_id: templateId,
      meta_message_id: wamid,
    })
    .select("id, conversa_id, direcao, conteudo, status, created_at")
    .single();

  if (insertError || !msg) {
    // A mensagem JÁ foi enviada no Meta, mas falhou ao salvar: loga a
    // inconsistência para reconciliação manual/futuro webhook.
    console.error(
      `[whatsapp] enviada no Meta (wamid=${wamid}) mas falhou ao salvar (conversa=${conversaId}): ${
        insertError?.message ?? "sem dados"
      }`,
    );
    return NextResponse.json(
      { error: "Mensagem enviada, mas falhou ao registrar." },
      { status: 500 },
    );
  }

  // Atualiza a ordenação da lista de conversas.
  await supabase
    .from("conversas")
    .update({ ultima_mensagem_em: msg.created_at })
    .eq("id", conversaId);

  return NextResponse.json(
    {
      mensagem: {
        id: msg.id,
        conversaId: msg.conversa_id,
        direcao: msg.direcao,
        conteudo: msg.conteudo,
        status: msg.status,
        createdAt: msg.created_at,
      },
      wamid, // já persistido em mensagens.meta_message_id.
    },
    { status: 201 },
  );
}

// =============================================================================
// NOTAS DE SEGURANÇA
// =============================================================================
// - TOKEN NO SERVIDOR: access_token é lido via service_role e usado apenas no
//   header Authorization do fetch ao Meta. Nunca é selecionado para o browser
//   nem incluído em nenhuma resposta JSON (sucesso ou erro).
// - ISOLAMENTO: a conversa é lida pelo cliente de sessão (RLS). Se ela for de
//   outra empresa, o RLS a esconde e respondemos 404 — não há como enviar em
//   conversa alheia. O canal é buscado por conversa.empresa_id (a empresa já
//   validada), então as credenciais usadas são sempre as da empresa correta.
// - JANELA 24h: texto livre exige janela_expira_em > now(); fora dela, 422 com
//   code 'janela_fechada'. Templates aprovados passam mesmo fora da janela.
// - WAMID: o id retornado pelo Meta é gravado em mensagens.meta_message_id
//   (migration 014) para casar, depois, os callbacks de status (entregue/lida)
//   do webhook com a mensagem.
// =============================================================================
