import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

// /inicio é um ROTEADOR por papel (decisão tomada no servidor):
//   - superadmin        -> /admin   (ele gerencia, não opera o funil)
//   - usuário de empresa -> /funil   (operação do CRM)
//   - sem perfil/empresa -> mensagem neutra (conta ainda não provisionada)
export default async function InicioPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, is_super_admin")
    .eq("id", user.id)
    .single();

  if (perfil?.is_super_admin) {
    redirect("/admin");
  }

  if (perfil?.empresa_id) {
    redirect("/funil");
  }

  // Sem perfil ou sem empresa: nada a operar ainda.
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          zap<span className="text-accent">flow</span>
        </h1>
        <p className="mt-2 max-w-sm text-sm text-foreground/60">
          Sua conta ainda não está vinculada a nenhuma empresa. Fale com o
          administrador para concluir o acesso.
        </p>
      </div>

      <SignOutButton />
    </main>
  );
}
