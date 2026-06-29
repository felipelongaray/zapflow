import { NextResponse } from "next/server";
import { obterSituacaoAcesso } from "@/lib/auth/acesso";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET_MIDIA_MENSAGENS } from "@/lib/whatsapp/midia";

// GET /api/midia/{empresa_id}/{conversa_id}/{arquivo}
// Valida sessão + tenant pelo 1º segmento do path; só então gera signed URL
// (service_role) e redireciona. O browser nunca vê a signed URL no HTML/SSR —
// aponta para esta rota, que autoriza e redireciona.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SEG = 3600;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segmentos } = await params;

  if (
    !segmentos?.length ||
    segmentos.length < 3 ||
    segmentos.some((s) => !s || s === "." || s === ".." || s.includes("\\"))
  ) {
    return NextResponse.json({ error: "Path inválido." }, { status: 400 });
  }

  const storagePath = segmentos.join("/");
  const empresaIdDoPath = segmentos[0]!;

  if (!UUID_RE.test(empresaIdDoPath) || !UUID_RE.test(segmentos[1]!)) {
    return NextResponse.json({ error: "Path inválido." }, { status: 400 });
  }

  // (b) Autorização com cliente de SESSÃO — nunca service_role aqui.
  const acesso = await obterSituacaoAcesso();

  if (acesso.tipo === "sem-sessao") {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  // Superadmin enxerga qualquer tenant; demais só a própria empresa.
  if (acesso.tipo !== "superadmin") {
    if (acesso.tipo !== "ativa") {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }
    if (empresaIdDoPath !== acesso.empresaId) {
      return NextResponse.json({ error: "Acesso negado." }, { status: 403 });
    }
  }

  // (c) Signed URL só DEPOIS de autorizado — service_role no servidor.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Erro interno." }, { status: 500 });
  }

  const { data, error } = await admin.storage
    .from(BUCKET_MIDIA_MENSAGENS)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEG);

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: "Arquivo não encontrado." },
      { status: 404 },
    );
  }

  return NextResponse.redirect(data.signedUrl);
}
