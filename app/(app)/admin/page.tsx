import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NovaEmpresaForm } from "./nova-empresa-form";

export type Empresa = {
  id: string;
  nome: string;
  max_canais: number;
  max_usuarios: number;
  status: string;
  created_at: string;
};

// Área do superadmin. A checagem de privilégio é feita NO SERVIDOR aqui (além
// do proxy, que só garante autenticação). Nunca confiamos em checagem do client.
export default async function AdminPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Sem usuário, manda para login (o proxy já cobre, mas reforçamos).
  if (!user) {
    redirect("/login");
  }

  const { data: perfil } = await supabase
    .from("perfis")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  // Não é superadmin -> fora daqui.
  if (!perfil?.is_super_admin) {
    redirect("/inicio");
  }

  // Superadmin: lista todas as empresas (a policy de RLS já permite ver todas).
  const { data: empresas } = await supabase
    .from("empresas")
    .select("id, nome, max_canais, max_usuarios, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          Admin · <span className="text-accent">empresas</span>
        </h1>
        <p className="mt-1 text-sm text-foreground/60">
          Crie empresas e o login do respectivo dono.
        </p>
      </header>

      <NovaEmpresaForm />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-foreground/50">
          Empresas ({empresas?.length ?? 0})
        </h2>

        {!empresas || empresas.length === 0 ? (
          <p className="text-sm text-foreground/50">
            Nenhuma empresa cadastrada ainda.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {empresas.map((e: Empresa) => (
              <li
                key={e.id}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{e.nome}</span>
                  <span
                    className={
                      e.status === "ativa"
                        ? "rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
                        : "rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-foreground/60"
                    }
                  >
                    {e.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground/50">
                  {e.max_canais} canal(is) · {e.max_usuarios} usuário(s) ·{" "}
                  {new Date(e.created_at).toLocaleDateString("pt-BR")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
