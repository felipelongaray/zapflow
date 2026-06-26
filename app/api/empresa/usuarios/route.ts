import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { exigirDonoNaRota } from "@/lib/empresa/guard";
import { falha } from "@/lib/admin/http";

// POST /api/empresa/usuarios
// O DONO adiciona um ATENDENTE à própria empresa: cria o login (service_role) e
// o perfil (papel='atendente'), respeitando o teto max_usuarios da empresa.
//
// FLUXO DE SEGURANÇA (a ordem importa):
//   1) exigirDonoNaRota() identifica o chamador pela SESSÃO (cliente sob RLS) e
//      confirma que ele é DONO de uma empresa. A empresa do novo atendente vem
//      DESTE contexto (auth.empresaId) — nunca de um campo enviado pelo cliente,
//      então não há como criar atendente em empresa alheia.
//   2) VALIDA O LIMITE no servidor (conta perfis vs max_usuarios). A UI também
//      desabilita o botão, mas isso é só UX; a checagem real e não-burlável é
//      esta. (O banco ainda reforça via trigger — migration 009 — como rede de
//      segurança contra corrida entre dois cadastros simultâneos.)
//   3) SÓ ENTÃO usa a service_role para escrever, com cleanup em falha parcial.

type Body = {
  nome?: string;
  email?: string;
  senha?: string;
};

export async function POST(request: Request) {
  // 1. AUTENTICAÇÃO + AUTORIZAÇÃO (dono, no servidor).
  const auth = await exigirDonoNaRota();
  if (auth.erro) {
    return auth.erro;
  }

  // VALIDAÇÃO DE ENTRADA.
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const nome = body.nome?.trim();
  const email = body.email?.trim().toLowerCase();
  const senha = body.senha ?? "";

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Email inválido." }, { status: 400 });
  }
  if (senha.length < 8) {
    return NextResponse.json(
      { error: "A senha deve ter ao menos 8 caracteres." },
      { status: 400 },
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return falha(
      "inicializar o cliente admin",
      e instanceof Error ? e.message : String(e),
      500,
    );
  }

  // 2. CHECAGEM DE LIMITE NO SERVIDOR (não confiar na UI).
  const { count, error: countError } = await admin
    .from("perfis")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", auth.empresaId);

  if (countError) {
    return falha("contar usuários da empresa", countError.message, 500);
  }

  const { data: empresa, error: empresaError } = await admin
    .from("empresas")
    .select("max_usuarios")
    .eq("id", auth.empresaId)
    .maybeSingle();

  if (empresaError) {
    return falha("ler o limite da empresa", empresaError.message, 500);
  }
  if (!empresa) {
    return NextResponse.json(
      { error: "Empresa não encontrada." },
      { status: 404 },
    );
  }

  if ((count ?? 0) >= empresa.max_usuarios) {
    return NextResponse.json(
      {
        error:
          "Limite de usuários atingido. Contate o suporte para aumentar.",
      },
      { status: 409 },
    );
  }

  // 3. ESCRITA COM service_role (cleanup em falha parcial).
  // 3a. Cria o login do atendente (já confirmado).
  const { data: criado, error: userError } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { nome: nome ?? null },
  });

  if (userError || !criado?.user) {
    const duplicado = /already been registered|already exists/i.test(
      userError?.message ?? "",
    );
    return falha(
      "criar o login do atendente",
      duplicado ? "Já existe um usuário com esse email." : userError?.message,
      duplicado ? 409 : 400,
    );
  }

  const atendenteId = criado.user.id;

  // 3b. Cria o perfil do atendente na empresa do DONO.
  const { error: perfilError } = await admin.from("perfis").insert({
    id: atendenteId,
    empresa_id: auth.empresaId,
    nome: nome ?? null,
    papel: "atendente",
    is_super_admin: false,
  });

  if (perfilError) {
    // Cleanup: desfaz o login para não deixar usuário órfão no auth (ex.: se o
    // banco recusar por estouro de limite numa corrida — trigger da 009).
    await admin.auth.admin.deleteUser(atendenteId);
    const limite = /limite de usu/i.test(perfilError.message);
    return falha(
      "criar o perfil do atendente",
      limite
        ? "Limite de usuários atingido. Contate o suporte para aumentar."
        : perfilError.message,
      limite ? 409 : 500,
    );
  }

  return NextResponse.json(
    {
      usuario: {
        id: atendenteId,
        nome: nome ?? null,
        email,
        papel: "atendente",
      },
    },
    { status: 201 },
  );
}
