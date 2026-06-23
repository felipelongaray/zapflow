"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const inputClass =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-foreground outline-none transition focus:border-accent focus:ring-1 focus:ring-accent";
const labelClass = "text-sm font-medium text-foreground/80";

export function NovaEmpresaForm() {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    const form = e.currentTarget;
    const dados = new FormData(form);

    const payload = {
      empresa: {
        nome: String(dados.get("empresa_nome") ?? ""),
        max_canais: Number(dados.get("max_canais") ?? 1),
        max_usuarios: Number(dados.get("max_usuarios") ?? 2),
      },
      dono: {
        nome: String(dados.get("dono_nome") ?? ""),
        email: String(dados.get("dono_email") ?? ""),
        senha: String(dados.get("dono_senha") ?? ""),
      },
    };

    const res = await fetch("/api/admin/criar-empresa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setEnviando(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErro(data.error ?? "Não foi possível criar a empresa.");
      return;
    }

    form.reset();
    setAberto(false);
    // Atualiza a lista (Server Component) sem reload completo.
    router.refresh();
  }

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="rounded-lg bg-accent px-4 py-2.5 font-semibold text-[#0E1512] transition hover:brightness-95"
      >
        Nova empresa
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 rounded-xl border border-white/10 bg-white/5 p-5"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-foreground/50">
          Empresa
        </legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="empresa_nome" className={labelClass}>
            Nome da empresa
          </label>
          <input id="empresa_nome" name="empresa_nome" type="text" required className={inputClass} />
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
              defaultValue={1}
              required
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
              defaultValue={2}
              required
              className={inputClass}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-foreground/50">
          Dono
        </legend>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="dono_nome" className={labelClass}>
            Nome do dono
          </label>
          <input id="dono_nome" name="dono_nome" type="text" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="dono_email" className={labelClass}>
            Email do dono
          </label>
          <input
            id="dono_email"
            name="dono_email"
            type="email"
            autoComplete="off"
            required
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="dono_senha" className={labelClass}>
            Senha do dono (mín. 8 caracteres)
          </label>
          <input
            id="dono_senha"
            name="dono_senha"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            className={inputClass}
          />
        </div>
      </fieldset>

      {erro && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {erro}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={enviando}
          className="rounded-lg bg-accent px-4 py-2.5 font-semibold text-[#0E1512] transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {enviando ? "Criando..." : "Criar empresa"}
        </button>
        <button
          type="button"
          onClick={() => {
            setErro(null);
            setAberto(false);
          }}
          className="rounded-lg border border-white/15 px-4 py-2.5 font-medium text-foreground transition hover:bg-white/5"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
