import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Autorização de DONO, decidida NO SERVIDOR com o cliente de SESSÃO (sob RLS).
// É a base da gestão de equipe: deve rodar ANTES de qualquer uso da service_role,
// exatamente como o guard de superadmin. Nunca lê perfis com a service_role.
//
// "Ser dono" exige as três condições juntas:
//   - não é superadmin (superadmin gerencia o sistema, não a equipe de um tenant);
//   - papel = 'dono';
//   - tem empresa_id (um dono sempre pertence a uma empresa).
export async function obterContextoDono() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { supabase, user: null, ehDono: false as const, empresaId: null };
  }

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, papel, is_super_admin")
    .eq("id", user.id)
    .single();

  const ehDono =
    !perfil?.is_super_admin &&
    perfil?.papel === "dono" &&
    !!perfil?.empresa_id;

  return {
    supabase,
    user,
    ehDono,
    empresaId: ehDono ? (perfil!.empresa_id as string) : null,
  };
}

// Variante para ROTAS (Route Handlers): devolve uma resposta de erro pronta
// (401/403) quando o chamador não é o dono autenticado de uma empresa. O handler
// deve fazer `return r.erro` e só prosseguir quando `erro === null` — daí em
// diante `empresaId` é garantidamente a empresa do dono (não vem do cliente).
export async function exigirDonoNaRota() {
  const ctx = await obterContextoDono();

  if (!ctx.user) {
    return {
      erro: NextResponse.json({ error: "Não autenticado." }, { status: 401 }),
    } as const;
  }

  if (!ctx.ehDono || !ctx.empresaId) {
    return {
      erro: NextResponse.json(
        { error: "Acesso restrito ao dono da empresa." },
        { status: 403 },
      ),
    } as const;
  }

  return {
    erro: null,
    supabase: ctx.supabase,
    user: ctx.user,
    empresaId: ctx.empresaId,
  } as const;
}
