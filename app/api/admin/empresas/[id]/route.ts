import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { exigirSuperadminNaRota } from "@/lib/admin/guard";
import { falha } from "@/lib/admin/http";

// Rotas de gestão de UMA empresa (somente superadmin):
//   PATCH  -> editar (nome/limites) e/ou suspender/reativar (status)
//   DELETE -> excluir empresa + logins do auth dos seus usuários
//
// FLUXO DE SEGURANÇA (igual em ambos os métodos):
//   1) exigirSuperadminNaRota() valida sessão + privilégio (via cliente de
//      sessão, sob RLS). Sem isso, 401/403 e NADA acontece.
//   2) Só então instanciamos a service_role para escrever.

type PatchBody = {
  nome?: string;
  max_canais?: number;
  max_usuarios?: number;
  status?: string;
};

type DeleteBody = {
  nome?: string;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await exigirSuperadminNaRota();
  if (auth.erro) {
    return auth.erro;
  }

  const { id } = await params;

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  // Monta o update apenas com os campos enviados, validando cada um.
  const update: Record<string, unknown> = {};

  if (body.nome !== undefined) {
    const nome = body.nome.trim();
    if (!nome) {
      return NextResponse.json(
        { error: "Nome da empresa não pode ser vazio." },
        { status: 400 },
      );
    }
    update.nome = nome;
  }

  if (body.max_canais !== undefined) {
    const n = Number(body.max_canais);
    if (!Number.isInteger(n) || n < 1) {
      return NextResponse.json(
        { error: "max_canais deve ser um inteiro >= 1." },
        { status: 400 },
      );
    }
    update.max_canais = n;
  }

  if (body.max_usuarios !== undefined) {
    const n = Number(body.max_usuarios);
    if (!Number.isInteger(n) || n < 1) {
      return NextResponse.json(
        { error: "max_usuarios deve ser um inteiro >= 1." },
        { status: 400 },
      );
    }
    update.max_usuarios = n;
  }

  if (body.status !== undefined) {
    if (body.status !== "ativa" && body.status !== "suspensa") {
      return NextResponse.json(
        { error: "status deve ser 'ativa' ou 'suspensa'." },
        { status: 400 },
      );
    }
    update.status = body.status;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "Nenhum campo válido para atualizar." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: empresa, error } = await admin
    .from("empresas")
    .update(update)
    .eq("id", id)
    .select("id, nome, max_canais, max_usuarios, status, created_at")
    .maybeSingle();

  if (error) {
    return falha("atualizar a empresa", error.message, 500);
  }
  if (!empresa) {
    return NextResponse.json(
      { error: "Empresa não encontrada." },
      { status: 404 },
    );
  }

  return NextResponse.json({ empresa }, { status: 200 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await exigirSuperadminNaRota();
  if (auth.erro) {
    return auth.erro;
  }

  const { id } = await params;

  let body: DeleteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Busca a empresa real para a DUPLA CHECAGEM do nome no servidor (não confiar
  // só no frontend) e para listar os usuários antes de apagar.
  const { data: empresa, error: empresaError } = await admin
    .from("empresas")
    .select("id, nome")
    .eq("id", id)
    .maybeSingle();

  if (empresaError) {
    return falha("buscar a empresa", empresaError.message, 500);
  }
  if (!empresa) {
    return NextResponse.json(
      { error: "Empresa não encontrada." },
      { status: 404 },
    );
  }

  // Confirmação por nome EXATO, validada no servidor.
  if ((body.nome ?? "").trim() !== empresa.nome) {
    return NextResponse.json(
      { error: "O nome informado não confere com o nome da empresa." },
      { status: 400 },
    );
  }

  // Coleta os ids dos usuários (perfis) ANTES de apagar a empresa — depois do
  // cascade os perfis somem e perderíamos a referência aos logins do auth.
  const { data: perfis, error: perfisError } = await admin
    .from("perfis")
    .select("id")
    .eq("empresa_id", id);

  if (perfisError) {
    return falha("listar usuários da empresa", perfisError.message, 500);
  }

  // Exclui a empresa. O cascade do banco remove perfis, canais, contatos,
  // conversas, mensagens e etapas vinculados.
  const { error: deleteError } = await admin
    .from("empresas")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return falha("excluir a empresa", deleteError.message, 500);
  }

  // Remove os logins do auth. O cascade do banco apaga as LINHAS de perfil, mas
  // NÃO remove o usuário em auth.users — isso precisa ser explícito. Erros aqui
  // não revertem a exclusão (a empresa já foi apagada); apenas logamos para não
  // deixar logins órfãos passarem despercebidos.
  const idsUsuarios = (perfis ?? []).map((p) => p.id);
  const falhasAuth: string[] = [];
  for (const uid of idsUsuarios) {
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) {
      falhasAuth.push(uid);
      console.error(
        `[admin] empresa ${id} excluída, mas falhou ao remover login ${uid}: ${error.message}`,
      );
    }
  }

  return NextResponse.json(
    {
      ok: true,
      usuarios_removidos: idsUsuarios.length - falhasAuth.length,
      usuarios_com_falha: falhasAuth.length,
    },
    { status: 200 },
  );
}
