import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { exigirSuperadminNaRota } from "@/lib/admin/guard";
import { falha } from "@/lib/admin/http";

// POST /api/admin/criar-empresa
// Cria, de forma atômica do ponto de vista do usuário: empresa + funil padrão +
// login do dono + perfil do dono. SÓ pode ser chamado por um superadmin.
//
// FLUXO DE SEGURANÇA (a ordem importa):
//   1) Identifica o chamador pela SESSÃO (cliente normal, sujeito a RLS).
//   2) Confirma no SERVIDOR que ele é superadmin (perfis.is_super_admin).
//   3) SÓ ENTÃO usa o cliente admin (service_role) para escrever.
// A service_role nunca é tocada antes da checagem passar.

type Body = {
  empresa?: { nome?: string; max_canais?: number; max_usuarios?: number };
  dono?: { nome?: string; email?: string; senha?: string };
};

export async function POST(request: Request) {
  // -------------------------------------------------------------------------
  // 1 + 2. AUTENTICAÇÃO E AUTORIZAÇÃO (obrigatórias, no servidor)
  // -------------------------------------------------------------------------
  const auth = await exigirSuperadminNaRota();
  if (auth.erro) {
    return auth.erro;
  }

  // -------------------------------------------------------------------------
  // VALIDAÇÃO DE ENTRADA
  // -------------------------------------------------------------------------
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const nomeEmpresa = body.empresa?.nome?.trim();
  const maxCanais = Number(body.empresa?.max_canais ?? 1);
  const maxUsuarios = Number(body.empresa?.max_usuarios ?? 2);
  const nomeDono = body.dono?.nome?.trim();
  const emailDono = body.dono?.email?.trim().toLowerCase();
  const senhaDono = body.dono?.senha ?? "";

  if (!nomeEmpresa) {
    return NextResponse.json(
      { error: "Nome da empresa é obrigatório." },
      { status: 400 },
    );
  }
  if (!emailDono || !emailDono.includes("@")) {
    return NextResponse.json(
      { error: "Email do dono inválido." },
      { status: 400 },
    );
  }
  if (senhaDono.length < 8) {
    return NextResponse.json(
      { error: "A senha do dono deve ter ao menos 8 caracteres." },
      { status: 400 },
    );
  }
  if (
    !Number.isInteger(maxCanais) ||
    maxCanais < 1 ||
    !Number.isInteger(maxUsuarios) ||
    maxUsuarios < 1
  ) {
    return NextResponse.json(
      { error: "Limites (canais/usuários) devem ser inteiros >= 1." },
      { status: 400 },
    );
  }

  // -------------------------------------------------------------------------
  // 3. ESCRITA COM service_role (com cleanup em caso de falha parcial)
  // -------------------------------------------------------------------------
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

  // 3a. Cria a empresa.
  const { data: empresa, error: empresaError } = await admin
    .from("empresas")
    .insert({
      nome: nomeEmpresa,
      max_canais: maxCanais,
      max_usuarios: maxUsuarios,
    })
    .select("id, nome, max_canais, max_usuarios, status, created_at")
    .single();

  if (empresaError || !empresa) {
    return falha("criar a empresa", empresaError?.message, 500);
  }

  // 3a.1. Cria o funil padrão da empresa (Novo / Em atendimento / Fechado).
  const { error: etapasError } = await admin.rpc("criar_etapas_padrao", {
    empresa_uuid: empresa.id,
  });

  if (etapasError) {
    // Cleanup: desfaz a empresa (as etapas têm cascade na empresa, então não
    // sobram órfãs). Ainda não criamos usuário/perfil nesta etapa.
    await admin.from("empresas").delete().eq("id", empresa.id);
    return falha("criar o funil padrão da empresa", etapasError.message, 500);
  }

  // 3b. Cria o login do dono (já confirmado, sem email de verificação).
  const { data: criado, error: userError } = await admin.auth.admin.createUser({
    email: emailDono,
    password: senhaDono,
    email_confirm: true,
    user_metadata: { nome: nomeDono ?? null },
  });

  if (userError || !criado?.user) {
    // Cleanup: desfaz a empresa órfã.
    await admin.from("empresas").delete().eq("id", empresa.id);
    const duplicado = /already been registered|already exists/i.test(
      userError?.message ?? "",
    );
    return falha(
      "criar o login do dono",
      duplicado ? "Já existe um usuário com esse email." : userError?.message,
      duplicado ? 409 : 400,
    );
  }

  const donoId = criado.user.id;

  // 3c. Cria o perfil do dono vinculado à empresa.
  const { error: perfilInsertError } = await admin.from("perfis").insert({
    id: donoId,
    empresa_id: empresa.id,
    nome: nomeDono ?? null,
    papel: "dono",
    is_super_admin: false,
  });

  if (perfilInsertError) {
    // Cleanup: desfaz o usuário e a empresa para não deixar lixo pela metade.
    await admin.auth.admin.deleteUser(donoId);
    await admin.from("empresas").delete().eq("id", empresa.id);
    return falha("criar o perfil do dono", perfilInsertError.message, 500);
  }

  return NextResponse.json({ empresa }, { status: 201 });
}
