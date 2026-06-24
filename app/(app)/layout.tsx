import { obterSituacaoAcesso } from "@/lib/auth/acesso";
import { SignOutButton } from "./inicio/sign-out-button";

// Layout do grupo (app): ponto ÚNICO e no SERVIDOR que cobre TODAS as rotas do
// CRM (/inicio, /admin, /funil e futuras). Aqui aplicamos o bloqueio efetivo de
// empresas suspensas — se a empresa do usuário estiver 'suspensa', renderizamos
// a tela de acesso suspenso no lugar do conteúdo, sem nem montar a página.
//
// O superadmin (sem empresa) e usuários de empresa ativa passam direto; cada
// página continua responsável pelos seus próprios redirects de papel.
// /login e /logout ficam no grupo (auth), fora deste layout — nunca bloqueados.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const situacao = await obterSituacaoAcesso();

  if (situacao.tipo === "suspensa") {
    return <AcessoSuspenso />;
  }

  return <>{children}</>;
}

function AcessoSuspenso() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div className="max-w-sm">
        <span className="inline-block rounded-full bg-warning-subtle px-3 py-1 text-xs font-medium text-warning">
          Acesso suspenso
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">
          Sua empresa está temporariamente suspensa
        </h1>
        <p className="mt-2 text-sm text-muted">
          O acesso ao zapflow foi pausado. Entre em contato com o suporte para
          regularizar a situação.
        </p>
      </div>

      <SignOutButton />
    </main>
  );
}
