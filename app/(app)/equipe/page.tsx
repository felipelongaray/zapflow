import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SignOutButton } from "../inicio/sign-out-button";
import { GestaoEquipe, type Usuario } from "./equipe-client";

// Tela "Equipe": gestão de usuários da empresa, restrita ao DONO.
// A checagem de papel é feita NO SERVIDOR (esconder do atendente é só UX; a trava
// real é o RLS + as triggers de privilégio + os guards das rotas).
export default async function EquipePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, is_super_admin, papel")
    .eq("id", user.id)
    .single();

  // Roteamento por papel (mesmo critério das outras telas).
  if (perfil?.is_super_admin) redirect("/admin");
  if (!perfil?.empresa_id) redirect("/inicio");
  if (perfil.papel !== "dono") redirect("/funil");

  // Lista de perfis da empresa via cliente de SESSÃO (sob RLS: a policy
  // perfis_select já devolve apenas perfis da própria empresa). Não usamos
  // service_role para LISTAR — só para complementar com o email do auth.
  const { data: perfis } = await supabase
    .from("perfis")
    .select("id, nome, papel, created_at")
    .order("created_at", { ascending: true });

  const { data: empresa } = await supabase
    .from("empresas")
    .select("nome, max_usuarios")
    .eq("id", perfil.empresa_id)
    .maybeSingle();

  // Emails só existem em auth.users (não em perfis). O dono não pode ler
  // auth.users; buscamos via service_role APÓS confirmar que o chamador é dono.
  const admin = createAdminClient();
  const usuarios: Usuario[] = await Promise.all(
    (perfis ?? []).map(async (p) => {
      const { data } = await admin.auth.admin.getUserById(p.id);
      return {
        id: p.id,
        nome: p.nome,
        email: data.user?.email ?? null,
        papel: p.papel as "dono" | "atendente",
      };
    }),
  );

  const limite = empresa?.max_usuarios ?? 0;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10">
      <Link
        href="/funil"
        className="text-sm text-muted transition hover:text-foreground"
      >
        ← Funil
      </Link>

      <header className="mt-4 mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Equipe</h1>
          <p className="mt-1 text-sm text-muted">
            {empresa?.nome ?? "Sua empresa"} · usuários e atendentes
          </p>
        </div>
        <SignOutButton />
      </header>

      <GestaoEquipe
        usuariosIniciais={usuarios}
        limite={limite}
        donoId={user.id}
      />
    </main>
  );
}
