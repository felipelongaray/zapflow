"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import {
  mascararTelefone,
  telefoneParaArmazenamento,
  telefoneParaExibicao,
  validarTelefoneBR,
} from "@/lib/telefone";

export type Etapa = { id: string; nome: string; ordem: number };
export type Contato = {
  id: string;
  nome: string | null;
  telefone: string;
  etapa_id: string | null;
};

// Coluna virtual para contatos ainda sem etapa.
const SEM_ETAPA = "sem-etapa";

export function FunilBoard({
  empresaId,
  etapas,
  contatosIniciais,
}: {
  empresaId: string;
  etapas: Etapa[];
  contatosIniciais: Contato[];
}) {
  // Cliente Supabase do browser, estável entre renders.
  const [supabase] = useState(() => createClient());
  const [contatos, setContatos] = useState<Contato[]>(contatosIniciais);
  const [erro, setErro] = useState<string | null>(null);

  // Modais: criação (com etapa inicial opcional) e edição de um contato.
  const [criarEm, setCriarEm] = useState<string | null | undefined>(undefined);
  const [emEdicao, setEmEdicao] = useState<Contato | null>(null);

  // No mobile, exige um pequeno "segurar" antes de arrastar para não atrapalhar
  // o scroll; no desktop, um pequeno deslocamento ativa o drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 160, tolerance: 6 },
    }),
  );

  const temSemEtapa = contatos.some((c) => c.etapa_id === null);

  // Colunas: "Sem etapa" (só se houver) + etapas na ordem definida.
  const colunas = useMemo(() => {
    const lista: { id: string; nome: string }[] = [];
    if (temSemEtapa) lista.push({ id: SEM_ETAPA, nome: "Sem etapa" });
    for (const e of etapas) lista.push({ id: e.id, nome: e.nome });
    return lista;
  }, [etapas, temSemEtapa]);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const contatoId = String(active.id);
    const colunaDestino = String(over.id);
    const novaEtapa = colunaDestino === SEM_ETAPA ? null : colunaDestino;

    const atual = contatos.find((c) => c.id === contatoId);
    if (!atual || atual.etapa_id === novaEtapa) return;

    const etapaAnterior = atual.etapa_id;

    // 1) Atualização OTIMISTA: move o cartão na UI imediatamente.
    setContatos((prev) =>
      prev.map((c) => (c.id === contatoId ? { ...c, etapa_id: novaEtapa } : c)),
    );
    setErro(null);

    // 2) Persiste no banco. O RLS garante que o usuário só consegue atualizar
    // contatos da PRÓPRIA empresa (policy empresa_id = get_minha_empresa());
    // não enviamos empresa_id, então não há como mover para outra empresa.
    const { error } = await supabase
      .from("contatos")
      .update({ etapa_id: novaEtapa })
      .eq("id", contatoId);

    // 3) Se falhar (ex.: RLS bloqueou ou rede), REVERTE a UI.
    if (error) {
      setContatos((prev) =>
        prev.map((c) =>
          c.id === contatoId ? { ...c, etapa_id: etapaAnterior } : c,
        ),
      );
      setErro("Não foi possível mover o contato. Tente novamente.");
    }
  }

  // CRIAR — empresa_id é enviado explicitamente (a coluna não tem default), mas
  // o RLS (WITH CHECK empresa_id = get_minha_empresa()) garante que só pode ser
  // a própria empresa. Insert otimista após sucesso.
  async function criarContato(dados: {
    nome: string;
    telefone: string;
    etapaId: string | null;
  }) {
    const { data, error } = await supabase
      .from("contatos")
      .insert({
        empresa_id: empresaId,
        nome: dados.nome || null,
        telefone: dados.telefone,
        etapa_id: dados.etapaId,
      })
      .select("id, nome, telefone, etapa_id")
      .single();

    if (error || !data) {
      return "Não foi possível criar o contato.";
    }
    setContatos((prev) => [...prev, data as Contato]);
    setCriarEm(undefined);
    return null;
  }

  // EDITAR — update nome/telefone. RLS protege (só contatos da própria empresa).
  async function salvarContato(
    id: string,
    dados: { nome: string; telefone: string },
  ) {
    const { data, error } = await supabase
      .from("contatos")
      .update({ nome: dados.nome || null, telefone: dados.telefone })
      .eq("id", id)
      .select("id, nome, telefone, etapa_id")
      .single();

    if (error || !data) {
      return "Não foi possível salvar as alterações.";
    }
    setContatos((prev) =>
      prev.map((c) => (c.id === id ? (data as Contato) : c)),
    );
    setEmEdicao(null);
    return null;
  }

  // EXCLUIR — delete. RLS protege (só contatos da própria empresa).
  async function excluirContato(id: string) {
    const { error } = await supabase.from("contatos").delete().eq("id", id);
    if (error) {
      return "Não foi possível excluir o contato.";
    }
    setContatos((prev) => prev.filter((c) => c.id !== id));
    setEmEdicao(null);
    return null;
  }

  const etapaPadrao = etapas[0]?.id ?? "";

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground/50">
          Contatos
        </h2>
        <button
          type="button"
          onClick={() => setCriarEm(etapaPadrao || null)}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-[#0E1512] transition hover:brightness-95"
        >
          + Novo contato
        </button>
      </div>

      {erro && (
        <p
          role="alert"
          className="mx-5 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {erro}
        </p>
      )}

      {colunas.length === 0 ? (
        <p className="px-5 py-10 text-sm text-foreground/50">
          Nenhuma etapa configurada para esta empresa.
        </p>
      ) : (
        <DndContext id="funil-dnd" sensors={sensors} onDragEnd={handleDragEnd}>
          {/* Scroll horizontal das colunas; cada coluna rola na vertical. */}
          <div className="flex flex-1 gap-3 overflow-x-auto p-5">
            {colunas.map((coluna) => (
              <Coluna
                key={coluna.id}
                id={coluna.id}
                nome={coluna.nome}
                contatos={contatos.filter((c) =>
                  coluna.id === SEM_ETAPA
                    ? c.etapa_id === null
                    : c.etapa_id === coluna.id,
                )}
                onAdicionar={
                  coluna.id === SEM_ETAPA
                    ? undefined
                    : () => setCriarEm(coluna.id)
                }
                onEditar={(c) => setEmEdicao(c)}
              />
            ))}
          </div>
        </DndContext>
      )}

      {criarEm !== undefined && (
        <CriarContatoModal
          etapas={etapas}
          etapaInicial={criarEm}
          onFechar={() => setCriarEm(undefined)}
          onCriar={criarContato}
        />
      )}

      {emEdicao && (
        <EditarContatoModal
          contato={emEdicao}
          onFechar={() => setEmEdicao(null)}
          onSalvar={salvarContato}
          onExcluir={excluirContato}
        />
      )}
    </div>
  );
}

function Coluna({
  id,
  nome,
  contatos,
  onAdicionar,
  onEditar,
}: {
  id: string;
  nome: string;
  contatos: Contato[];
  onAdicionar?: () => void;
  onEditar: (c: Contato) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <section
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-xl border bg-white/[0.02] transition ${
        isOver ? "border-accent/60" : "border-[#243029]"
      }`}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{nome}</h2>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-foreground/50">
            {contatos.length}
          </span>
        </div>
        {onAdicionar && (
          <button
            type="button"
            onClick={onAdicionar}
            aria-label={`Novo contato em ${nome}`}
            className="rounded-md px-1.5 text-lg leading-none text-foreground/40 transition hover:bg-white/5 hover:text-accent"
          >
            +
          </button>
        )}
      </header>

      <div className="flex min-h-24 flex-1 flex-col gap-2 px-3 pb-3">
        {contatos.map((c) => (
          <Cartao key={c.id} contato={c} onEditar={() => onEditar(c)} />
        ))}
      </div>
    </section>
  );
}

function Cartao({
  contato,
  onEditar,
}: {
  contato: Contato;
  onEditar: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: contato.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className="flex items-start justify-between gap-2 rounded-lg border border-[#243029] bg-[#141D18] px-3 py-2.5"
    >
      {/* Área de ARRASTE: ocupa o corpo do card e recebe os listeners do dnd. */}
      <div
        {...listeners}
        {...attributes}
        className="min-w-0 flex-1 cursor-grab touch-none active:cursor-grabbing"
      >
        <p className="truncate text-sm font-medium text-foreground">
          {contato.nome ?? "Sem nome"}
        </p>
        <p className="mt-0.5 text-xs text-foreground/50">{contato.telefone}</p>
      </div>

      {/* Botão de EDITAR: stopPropagation no pointerdown impede que o dnd inicie
          um arraste, então este alvo é sempre um clique (abrir detalhes). */}
      <button
        type="button"
        aria-label="Editar contato"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onEditar}
        className="shrink-0 rounded-md p-1 text-foreground/40 transition hover:bg-white/5 hover:text-accent"
      >
        <IconeEditar />
      </button>
    </article>
  );
}

function CriarContatoModal({
  etapas,
  etapaInicial,
  onFechar,
  onCriar,
}: {
  etapas: Etapa[];
  etapaInicial: string | null;
  onFechar: () => void;
  onCriar: (dados: {
    nome: string;
    telefone: string;
    etapaId: string | null;
  }) => Promise<string | null>;
}) {
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const telefoneDisplay = String(fd.get("telefone") ?? "").trim();
    if (!telefoneDisplay) {
      setErro("Telefone é obrigatório.");
      return;
    }
    if (!validarTelefoneBR(telefoneDisplay)) {
      setErro("Telefone inválido. Confira o DDD e o número.");
      return;
    }
    const etapaSel = String(fd.get("etapa_id") ?? "");
    setSalvando(true);
    setErro(null);
    const msg = await onCriar({
      nome: String(fd.get("nome") ?? "").trim(),
      // Salva só dígitos com DDI 55; a máscara fica apenas na exibição.
      telefone: telefoneParaArmazenamento(telefoneDisplay),
      etapaId: etapaSel === "" ? null : etapaSel,
    });
    setSalvando(false);
    if (msg) setErro(msg);
  }

  return (
    <Modal titulo="Novo contato" onFechar={onFechar}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Campo label="Nome">
          <input name="nome" type="text" className={inputClass} autoFocus />
        </Campo>
        <Campo label="Telefone">
          <TelefoneInput name="telefone" />
        </Campo>
        <Campo label="Etapa inicial">
          <select
            name="etapa_id"
            defaultValue={etapaInicial ?? ""}
            className={inputClass}
          >
            <option value="">Sem etapa</option>
            {etapas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
        </Campo>

        {erro && <ErroMsg mensagem={erro} />}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={salvando}
            className="rounded-lg bg-accent px-4 py-2.5 font-semibold text-[#0E1512] transition hover:brightness-95 disabled:opacity-60"
          >
            {salvando ? "Criando..." : "Criar contato"}
          </button>
          <BotaoCancelar onClick={onFechar} />
        </div>
      </form>
    </Modal>
  );
}

function EditarContatoModal({
  contato,
  onFechar,
  onSalvar,
  onExcluir,
}: {
  contato: Contato;
  onFechar: () => void;
  onSalvar: (
    id: string,
    dados: { nome: string; telefone: string },
  ) => Promise<string | null>;
  onExcluir: (id: string) => Promise<string | null>;
}) {
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const telefoneDisplay = String(fd.get("telefone") ?? "").trim();
    if (!telefoneDisplay) {
      setErro("Telefone é obrigatório.");
      return;
    }
    if (!validarTelefoneBR(telefoneDisplay)) {
      setErro("Telefone inválido. Confira o DDD e o número.");
      return;
    }
    setSalvando(true);
    setErro(null);
    const msg = await onSalvar(contato.id, {
      nome: String(fd.get("nome") ?? "").trim(),
      // Normaliza para 55 + dígitos antes de gravar.
      telefone: telefoneParaArmazenamento(telefoneDisplay),
    });
    setSalvando(false);
    if (msg) setErro(msg);
  }

  async function handleExcluir() {
    setSalvando(true);
    setErro(null);
    const msg = await onExcluir(contato.id);
    setSalvando(false);
    if (msg) setErro(msg);
  }

  return (
    <Modal titulo="Editar contato" onFechar={onFechar}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Campo label="Nome">
          <input
            name="nome"
            type="text"
            defaultValue={contato.nome ?? ""}
            className={inputClass}
            autoFocus
          />
        </Campo>
        <Campo label="Telefone">
          {/* Pré-preenche com o valor armazenado já formatado para exibição. */}
          <TelefoneInput
            name="telefone"
            valorInicialArmazenado={contato.telefone}
          />
        </Campo>

        {erro && <ErroMsg mensagem={erro} />}

        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={salvando}
              className="rounded-lg bg-accent px-4 py-2.5 font-semibold text-[#0E1512] transition hover:brightness-95 disabled:opacity-60"
            >
              {salvando ? "Salvando..." : "Salvar"}
            </button>
            <BotaoCancelar onClick={onFechar} />
          </div>

          {!confirmandoExclusao ? (
            <button
              type="button"
              onClick={() => setConfirmandoExclusao(true)}
              className="rounded-lg border border-red-500/40 px-3 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-500/10"
            >
              Excluir
            </button>
          ) : (
            <button
              type="button"
              onClick={handleExcluir}
              disabled={salvando}
              className="rounded-lg bg-red-500 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-60"
            >
              Confirmar exclusão
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  titulo,
  onFechar,
  children,
}: {
  titulo: string;
  onFechar: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onFechar}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-[#243029] bg-[#0E1512] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold tracking-tight">{titulo}</h2>
        {children}
      </div>
    </div>
  );
}

// Input controlado de telefone: mantém na tela o valor MASCARADO (camada de
// exibição). Na edição, inicializa a partir do valor armazenado convertido para
// exibição. O <input name> guarda a string mascarada; a conversão para o formato
// de armazenamento (55 + dígitos) acontece no submit do modal.
function TelefoneInput({
  name,
  valorInicialArmazenado,
}: {
  name: string;
  valorInicialArmazenado?: string;
}) {
  const [valor, setValor] = useState(() =>
    valorInicialArmazenado ? telefoneParaExibicao(valorInicialArmazenado) : "",
  );

  return (
    <input
      name={name}
      type="tel"
      inputMode="numeric"
      required
      placeholder="(11) 99999-9999"
      value={valor}
      onChange={(e) => setValor(mascararTelefone(e.target.value))}
      className={inputClass}
    />
  );
}

function Campo({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground/80">{label}</span>
      {children}
    </label>
  );
}

function BotaoCancelar({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-white/15 px-4 py-2.5 font-medium transition hover:bg-white/5"
    >
      Cancelar
    </button>
  );
}

function ErroMsg({ mensagem }: { mensagem: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
    >
      {mensagem}
    </p>
  );
}

function IconeEditar() {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

const inputClass =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-foreground outline-none transition focus:border-accent focus:ring-1 focus:ring-accent";
