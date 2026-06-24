import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "../inicio/sign-out-button";
import { FunilBoard, type Contato, type Etapa } from "./funil-board";

// O funil é a tela de OPERAÇÃO do CRM. Acesso só para usuários COM empresa_id.
// Superadmin não opera o funil -> vai para /admin.
export default async function FunilPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, is_super_admin, nome")
    .eq("id", user.id)
    .single();

  if (perfil?.is_super_admin) redirect("/admin");
  if (!perfil?.empresa_id) redirect("/inicio");

  // RLS já isola por empresa: estas queries retornam apenas as linhas da empresa
  // do usuário. Não precisamos (nem devemos) filtrar por empresa_id na mão.
  const [{ data: etapas }, { data: contatos }] = await Promise.all([
    supabase
      .from("etapas")
      .select("id, nome, ordem")
      .order("ordem", { ascending: true }),
    supabase
      .from("contatos")
      .select("id, nome, telefone, etapa_id")
      .order("created_at", { ascending: true }),
  ]);

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[#243029] px-5 py-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            zap<span className="text-accent">flow</span>
          </h1>
          <p className="text-xs text-foreground/50">Funil de atendimento</p>
        </div>
        <SignOutButton />
      </header>

      <FunilBoard
        empresaId={perfil.empresa_id}
        etapas={(etapas as Etapa[]) ?? []}
        contatosIniciais={(contatos as Contato[]) ?? []}
      />
    </main>
  );
}
