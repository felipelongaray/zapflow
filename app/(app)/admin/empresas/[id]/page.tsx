import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { obterContextoSuperadmin } from "@/lib/admin/guard";
import { EmpresaAcoes } from "./empresa-acoes";

export default async function EmpresaDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Autorização no servidor (além do proxy). Não-superadmin sai daqui.
  const { supabase, user, isSuperadmin } = await obterContextoSuperadmin();
  if (!user) redirect("/login");
  if (!isSuperadmin) redirect("/inicio");

  const { id } = await params;

  const { data: empresa } = await supabase
    .from("empresas")
    .select("id, nome, max_canais, max_usuarios, status, created_at")
    .eq("id", id)
    .maybeSingle();

  if (!empresa) {
    notFound();
  }

  // Uso atual: contagem de canais e usuários (perfis) da empresa.
  const [{ count: canaisCount }, { count: usuariosCount }] = await Promise.all([
    supabase
      .from("canais")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", id),
    supabase
      .from("perfis")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", id),
  ]);

  // Dono da empresa (perfil papel 'dono'); o email vem do auth via service_role.
  const { data: donos } = await supabase
    .from("perfis")
    .select("id, nome")
    .eq("empresa_id", id)
    .eq("papel", "dono")
    .order("created_at", { ascending: true });

  const dono = donos?.[0] ?? null;
  let donoEmail: string | null = null;
  if (dono) {
    const admin = createAdminClient();
    const { data } = await admin.auth.admin.getUserById(dono.id);
    donoEmail = data.user?.email ?? null;
  }

  // Etapas do funil, ordenadas.
  const { data: etapas } = await supabase
    .from("etapas")
    .select("id, nome, ordem")
    .eq("empresa_id", id)
    .order("ordem", { ascending: true });

  const suspensa = empresa.status === "suspensa";

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href="/admin"
        className="text-sm text-foreground/60 transition hover:text-foreground"
      >
        ← Empresas
      </Link>

      <header className="mt-4 mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{empresa.nome}</h1>
          <p className="mt-1 text-sm text-foreground/50">
            Criada em {new Date(empresa.created_at).toLocaleDateString("pt-BR")}
          </p>
        </div>
        <span
          className={
            suspensa
              ? "rounded-full bg-amber-400/15 px-3 py-1 text-xs font-medium text-amber-300"
              : "rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent"
          }
        >
          {empresa.status}
        </span>
      </header>

      {/* Uso x limites */}
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-wide text-foreground/50">
            Canais
          </p>
          <p className="mt-1 text-lg font-semibold">
            {canaisCount ?? 0}{" "}
            <span className="text-sm font-normal text-foreground/50">
              de {empresa.max_canais}
            </span>
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-wide text-foreground/50">
            Usuários
          </p>
          <p className="mt-1 text-lg font-semibold">
            {usuariosCount ?? 0}{" "}
            <span className="text-sm font-normal text-foreground/50">
              de {empresa.max_usuarios}
            </span>
          </p>
        </div>
      </section>

      {/* Dono */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-foreground/50">
          Dono
        </h2>
        {dono ? (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="font-medium">{dono.nome ?? "—"}</p>
            <p className="text-sm text-foreground/60">{donoEmail ?? "—"}</p>
          </div>
        ) : (
          <p className="text-sm text-foreground/50">Sem dono cadastrado.</p>
        )}
      </section>

      {/* Funil */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-foreground/50">
          Funil ({etapas?.length ?? 0} etapas)
        </h2>
        {etapas && etapas.length > 0 ? (
          <ol className="flex flex-wrap gap-2">
            {etapas.map((et) => (
              <li
                key={et.id}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm"
              >
                <span className="text-foreground/40">{et.ordem}.</span>{" "}
                {et.nome}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-foreground/50">Nenhuma etapa.</p>
        )}
      </section>

      {/* Ações (client) */}
      <section className="mt-10 border-t border-white/10 pt-6">
        <EmpresaAcoes
          empresa={{
            id: empresa.id,
            nome: empresa.nome,
            max_canais: empresa.max_canais,
            max_usuarios: empresa.max_usuarios,
            status: empresa.status,
          }}
        />
      </section>
    </main>
  );
}
