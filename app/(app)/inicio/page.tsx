import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

// Página protegida placeholder. O proxy já garante que só usuários autenticados
// chegam aqui; ainda assim lemos o usuário no servidor para exibir o email.
export default async function InicioPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Bem-vindo ao zap<span className="text-accent">flow</span>
        </h1>
        <p className="mt-2 text-sm text-foreground/60">
          Logado como{" "}
          <span className="font-medium text-foreground">{user?.email}</span>
        </p>
      </div>

      <SignOutButton />
    </main>
  );
}
