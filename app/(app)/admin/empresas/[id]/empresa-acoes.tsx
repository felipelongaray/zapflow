"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Empresa = {
  id: string;
  nome: string;
  max_canais: number;
  max_usuarios: number;
  status: string;
};

const inputClass =
  "rounded-lg border border-border bg-background px-3 py-2.5 text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary";
const labelClass = "text-sm font-medium text-foreground";

export function EmpresaAcoes({ empresa }: { empresa: Empresa }) {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const suspensa = empresa.status === "suspensa";

  async function patch(payload: Record<string, unknown>) {
    setErro(null);
    setOcupado(true);
    const res = await fetch(`/api/admin/empresas/${empresa.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setOcupado(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErro(data.error ?? "Não foi possível salvar.");
      return false;
    }
    return true;
  }

  async function handleEditar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dados = new FormData(e.currentTarget);
    const ok = await patch({
      nome: String(dados.get("nome") ?? ""),
      max_canais: Number(dados.get("max_canais") ?? 0),
      max_usuarios: Number(dados.get("max_usuarios") ?? 0),
    });
    if (ok) {
      setEditando(false);
      router.refresh();
    }
  }

  async function handleToggleStatus() {
    const ok = await patch({ status: suspensa ? "ativa" : "suspensa" });
    if (ok) router.refresh();
  }

  if (editando) {
    return (
      <form
        onSubmit={handleEditar}
        className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5"
      >
        <h2 className="text-sm font-semibold text-muted">
          Editar empresa
        </h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="nome" className={labelClass}>
            Nome
          </label>
          <input
            id="nome"
            name="nome"
            type="text"
            required
            defaultValue={empresa.nome}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="max_canais" className={labelClass}>
              Máx. canais
            </label>
            <input
              id="max_canais"
              name="max_canais"
              type="number"
              min={1}
              required
              defaultValue={empresa.max_canais}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="max_usuarios" className={labelClass}>
              Máx. usuários
            </label>
            <input
              id="max_usuarios"
              name="max_usuarios"
              type="number"
              min={1}
              required
              defaultValue={empresa.max_usuarios}
              className={inputClass}
            />
          </div>
        </div>

        {erro && <Erro mensagem={erro} />}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={ocupado}
            className="rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
          >
            {ocupado ? "Salvando..." : "Salvar"}
          </button>
          <button
            type="button"
            onClick={() => {
              setErro(null);
              setEditando(false);
            }}
            className="rounded-lg border border-border px-4 py-2.5 font-medium transition hover:bg-primary-subtle"
          >
            Cancelar
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => {
            setErro(null);
            setEditando(true);
          }}
          className="rounded-lg border border-border px-4 py-2.5 font-medium transition hover:bg-primary-subtle"
        >
          Editar
        </button>

        <button
          type="button"
          onClick={handleToggleStatus}
          disabled={ocupado}
          className={
            suspensa
              ? "rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-60"
              : "rounded-lg border border-warning/40 px-4 py-2.5 font-medium text-warning transition hover:bg-warning-subtle disabled:opacity-60"
          }
        >
          {suspensa ? "Reativar" : "Suspender"}
        </button>

        <button
          type="button"
          onClick={() => {
            setErro(null);
            setConfirmandoExclusao(true);
          }}
          className="rounded-lg border border-danger/40 px-4 py-2.5 font-medium text-danger transition hover:bg-danger-subtle"
        >
          Excluir
        </button>
      </div>

      {erro && !confirmandoExclusao && <Erro mensagem={erro} />}

      {confirmandoExclusao && (
        <ModalExcluir
          empresa={empresa}
          ocupado={ocupado}
          erro={erro}
          onCancelar={() => {
            setErro(null);
            setConfirmandoExclusao(false);
          }}
          onConfirmar={async (nomeDigitado) => {
            setErro(null);
            setOcupado(true);
            const res = await fetch(`/api/admin/empresas/${empresa.id}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ nome: nomeDigitado }),
            });
            setOcupado(false);
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              setErro(data.error ?? "Não foi possível excluir.");
              return;
            }
            router.push("/admin");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ModalExcluir({
  empresa,
  ocupado,
  erro,
  onCancelar,
  onConfirmar,
}: {
  empresa: Empresa;
  ocupado: boolean;
  erro: string | null;
  onCancelar: () => void;
  onConfirmar: (nomeDigitado: string) => void;
}) {
  const [nomeDigitado, setNomeDigitado] = useState("");
  const habilitado = nomeDigitado.trim() === empresa.nome && !ocupado;

  return (
    <div className="rounded-xl border border-danger/30 bg-danger-subtle p-5">
      <h2 className="font-semibold text-danger">Excluir empresa</h2>
      <p className="mt-2 text-sm text-muted">
        Esta ação é <strong>irreversível</strong>. Serão removidos todos os
        contatos, conversas, mensagens, etapas, usuários e os logins de acesso
        desta empresa.
      </p>
      <p className="mt-3 text-sm text-muted">
        Para confirmar, digite o nome exato:{" "}
        <span className="font-semibold text-foreground">{empresa.nome}</span>
      </p>
      <input
        type="text"
        value={nomeDigitado}
        onChange={(e) => setNomeDigitado(e.target.value)}
        autoComplete="off"
        className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-foreground outline-none transition focus:border-danger focus:ring-1 focus:ring-danger"
        placeholder="Nome da empresa"
      />

      {erro && <Erro mensagem={erro} />}

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={!habilitado}
          onClick={() => onConfirmar(nomeDigitado)}
          className="rounded-lg bg-danger px-4 py-2.5 font-semibold text-primary-foreground transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {ocupado ? "Excluindo..." : "Excluir definitivamente"}
        </button>
        <button
          type="button"
          onClick={onCancelar}
          className="rounded-lg border border-border px-4 py-2.5 font-medium transition hover:bg-primary-subtle"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

function Erro({ mensagem }: { mensagem: string }) {
  return (
    <p
      role="alert"
      className="mt-1 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
    >
      {mensagem}
    </p>
  );
}
