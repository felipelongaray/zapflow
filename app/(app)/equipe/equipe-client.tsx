"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type Usuario = {
  id: string;
  nome: string | null;
  email: string | null;
  papel: "dono" | "atendente";
};

const inputClass =
  "rounded-lg border border-border bg-background px-3 py-2.5 text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary";
const labelClass = "text-sm font-medium text-foreground";

export function GestaoEquipe({
  usuariosIniciais,
  limite,
  donoId,
}: {
  usuariosIniciais: Usuario[];
  limite: number;
  donoId: string;
}) {
  const router = useRouter();
  const [adicionando, setAdicionando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const usados = usuariosIniciais.length;
  const limiteAtingido = usados >= limite;

  async function adicionar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);

    const form = e.currentTarget;
    const fd = new FormData(form);
    const payload = {
      nome: String(fd.get("nome") ?? "").trim(),
      email: String(fd.get("email") ?? "").trim(),
      senha: String(fd.get("senha") ?? ""),
    };

    const res = await fetch("/api/empresa/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErro(data.error ?? "Não foi possível adicionar o atendente.");
      return;
    }

    form.reset();
    setAdicionando(false);
    // Recarrega a lista (Server Component) — re-busca emails e contagem.
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Uso do limite + ação principal */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <span className="font-semibold text-foreground">{usados}</span> de{" "}
          <span className="font-semibold text-foreground">{limite}</span>{" "}
          usuário(s)
        </p>

        {!adicionando && (
          <button
            type="button"
            disabled={limiteAtingido}
            title={
              limiteAtingido
                ? "Limite de usuários atingido. Contate o suporte para aumentar."
                : undefined
            }
            onClick={() => {
              setErro(null);
              setAdicionando(true);
            }}
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Adicionar atendente
          </button>
        )}
      </div>

      {limiteAtingido && !adicionando && (
        <p className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning">
          Limite de usuários atingido. Contate o suporte para aumentar.
        </p>
      )}

      {/* Formulário de novo atendente */}
      {adicionando && (
        <form
          onSubmit={adicionar}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5"
        >
          <h2 className="text-sm font-semibold text-muted">Novo atendente</h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nome" className={labelClass}>
              Nome
            </label>
            <input id="nome" name="nome" type="text" className={inputClass} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="off"
              required
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="senha" className={labelClass}>
              Senha (mín. 8 caracteres)
            </label>
            <input
              id="senha"
              name="senha"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className={inputClass}
            />
          </div>

          {erro && <ErroMsg mensagem={erro} />}

          <div className="flex gap-3">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition hover:bg-primary-hover"
            >
              Adicionar
            </button>
            <button
              type="button"
              onClick={() => {
                setErro(null);
                setAdicionando(false);
              }}
              className="rounded-lg border border-border px-4 py-2.5 font-medium text-foreground transition hover:bg-primary-subtle"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Erros de remoção aparecem fora do form */}
      {erro && !adicionando && <ErroMsg mensagem={erro} />}

      {/* Lista de usuários */}
      <ul className="flex flex-col gap-2">
        {usuariosIniciais.map((u) => (
          <LinhaUsuario
            key={u.id}
            usuario={u}
            podeRemover={u.papel === "atendente" && u.id !== donoId}
            onErro={(m) => setErro(m)}
            onRemovido={() => router.refresh()}
          />
        ))}
      </ul>
    </div>
  );
}

function LinhaUsuario({
  usuario,
  podeRemover,
  onErro,
  onRemovido,
}: {
  usuario: Usuario;
  podeRemover: boolean;
  onErro: (mensagem: string) => void;
  onRemovido: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [removendo, setRemovendo] = useState(false);

  async function remover() {
    setRemovendo(true);
    const res = await fetch(`/api/empresa/usuarios/${usuario.id}`, {
      method: "DELETE",
    });
    setRemovendo(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      onErro(data.error ?? "Não foi possível remover o atendente.");
      setConfirmando(false);
      return;
    }
    onRemovido();
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{usuario.nome ?? "Sem nome"}</p>
        <p className="truncate text-sm text-muted">{usuario.email ?? "—"}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span
          className={
            usuario.papel === "dono"
              ? "rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary"
              : "rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted"
          }
        >
          {usuario.papel}
        </span>

        {podeRemover &&
          (!confirmando ? (
            <button
              type="button"
              aria-label="Remover atendente"
              onClick={() => setConfirmando(true)}
              className="rounded-md p-1.5 text-muted transition hover:bg-danger-subtle hover:text-danger"
            >
              <IconeLixeira />
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={removendo}
                onClick={remover}
                className="rounded-md bg-danger px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-95 disabled:opacity-60"
              >
                {removendo ? "Removendo..." : "Confirmar"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmando(false)}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition hover:bg-primary-subtle"
              >
                Cancelar
              </button>
            </div>
          ))}
      </div>
    </li>
  );
}

function ErroMsg({ mensagem }: { mensagem: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
    >
      {mensagem}
    </p>
  );
}

function IconeLixeira() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
