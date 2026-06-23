import { createClient } from "@/lib/supabase/server";

// Situação de acesso de um usuário às áreas internas do app, decidida NO
// SERVIDOR a partir do perfil e do status da empresa.
export type SituacaoAcesso =
  | { tipo: "sem-sessao" }
  | { tipo: "superadmin" } // dono do sistema, sem empresa — nunca bloqueado
  | { tipo: "sem-empresa" } // autenticado, mas sem empresa vinculada
  | { tipo: "suspensa" } // empresa com status 'suspensa' — acesso bloqueado
  | { tipo: "ativa"; empresaId: string };

// Lê tudo com o cliente de SESSÃO (sob RLS): o usuário só enxerga o próprio
// perfil e a própria empresa. Não usa service_role.
export async function obterSituacaoAcesso(): Promise<SituacaoAcesso> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { tipo: "sem-sessao" };

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, is_super_admin")
    .eq("id", user.id)
    .single();

  if (perfil?.is_super_admin) return { tipo: "superadmin" };
  if (!perfil?.empresa_id) return { tipo: "sem-empresa" };

  const { data: empresa } = await supabase
    .from("empresas")
    .select("status")
    .eq("id", perfil.empresa_id)
    .maybeSingle();

  // Quando o superadmin reativa (status volta a 'ativa'), esta leitura passa a
  // retornar 'ativa' e o acesso é liberado automaticamente — sem nada a limpar.
  if (empresa?.status === "suspensa") return { tipo: "suspensa" };

  return { tipo: "ativa", empresaId: perfil.empresa_id };
}
