import { NextResponse } from "next/server";

// Tratamento de falha padronizado para as rotas de admin: um único log por erro
// no servidor (sem poluir) e uma resposta informativa indicando a etapa que
// falhou. O `detail` (mensagem crua do Supabase) é SEMPRE logado, mas só vai ao
// cliente fora de produção — em produção devolvemos apenas a mensagem amigável.
export function falha(
  etapa: string,
  detalhe: string | undefined,
  status: number,
) {
  const mensagem = `Falha ao ${etapa}.`;
  console.error(`[admin] ${mensagem} ${detalhe ?? ""}`.trim());
  const exporDetalhe = process.env.NODE_ENV !== "production" && detalhe;
  return NextResponse.json(
    { error: mensagem, ...(exporDetalhe ? { detail: detalhe } : {}) },
    { status },
  );
}
