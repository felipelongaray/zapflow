import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { exigirDonoNaRota } from "@/lib/empresa/guard";
import { falha } from "@/lib/admin/http";

// DELETE /api/empresa/usuarios/[id]
// O DONO remove um ATENDENTE da própria empresa: apaga o login no auth (o cascade
// de auth.users -> perfis remove a linha de perfil).
//
// FLUXO DE SEGURANÇA:
//   1) exigirDonoNaRota() confirma, pela SESSÃO, que o chamador é dono e de qual
//      empresa.
//   2) O alvo é validado com a service_role e precisa: existir, ser da MESMA
//      empresa do dono e ter papel='atendente'. Bloqueamos remover a si mesmo e
//      remover outro dono — só atendentes podem ser removidos.
//   3) SÓ ENTÃO removemos o login (e o perfil por cascade).

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await exigirDonoNaRota();
  if (auth.erro) {
    return auth.erro;
  }

  const { id } = await params;

  // Não pode remover a si mesmo (o dono não se auto-remove por aqui).
  if (id === auth.user.id) {
    return NextResponse.json(
      { error: "Você não pode remover a si mesmo." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Busca o alvo para validar empresa e papel no SERVIDOR (não confiar no front).
  const { data: alvo, error: alvoError } = await admin
    .from("perfis")
    .select("id, empresa_id, papel")
    .eq("id", id)
    .maybeSingle();

  if (alvoError) {
    return falha("buscar o usuário", alvoError.message, 500);
  }
  if (!alvo) {
    return NextResponse.json(
      { error: "Usuário não encontrado." },
      { status: 404 },
    );
  }

  // Isolamento de tenant: o dono só mexe na PRÓPRIA empresa.
  if (alvo.empresa_id !== auth.empresaId) {
    return NextResponse.json(
      { error: "Este usuário não pertence à sua empresa." },
      { status: 403 },
    );
  }

  // Só atendentes podem ser removidos (nunca um dono).
  if (alvo.papel !== "atendente") {
    return NextResponse.json(
      { error: "Apenas atendentes podem ser removidos." },
      { status: 403 },
    );
  }

  // Remove o login no auth. O FK perfis.id -> auth.users(id) ON DELETE CASCADE
  // apaga automaticamente a linha de perfil correspondente.
  const { error: deleteError } = await admin.auth.admin.deleteUser(id);
  if (deleteError) {
    return falha("remover o login do atendente", deleteError.message, 500);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
