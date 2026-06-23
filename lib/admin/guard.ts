import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Verifica, NO SERVIDOR, a sessão e o privilégio de superadmin. Lê perfis com o
// cliente de SESSÃO (sujeito a RLS) — nunca com a service_role. É a base de toda
// autorização da área de admin; deve rodar ANTES de qualquer uso da service_role.
export async function obterContextoSuperadmin() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { supabase, user: null, isSuperadmin: false as const };
  }

  const { data: perfil } = await supabase
    .from("perfis")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  return { supabase, user, isSuperadmin: !!perfil?.is_super_admin };
}

// Variante para ROTAS (Route Handlers): retorna uma resposta de erro pronta
// (401/403) quando o chamador não é um superadmin autenticado. O handler deve
// dar `return resultado.erro` e só prosseguir quando `erro === null`.
export async function exigirSuperadminNaRota() {
  const ctx = await obterContextoSuperadmin();

  if (!ctx.user) {
    return {
      erro: NextResponse.json({ error: "Não autenticado." }, { status: 401 }),
    } as const;
  }

  if (!ctx.isSuperadmin) {
    // 403: autenticado, mas sem privilégio. Nada é executado.
    return {
      erro: NextResponse.json(
        { error: "Acesso restrito ao superadmin." },
        { status: 403 },
      ),
    } as const;
  }

  return { erro: null, supabase: ctx.supabase, user: ctx.user } as const;
}
