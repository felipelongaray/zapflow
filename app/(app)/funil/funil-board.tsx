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
  etapas,
  contatosIniciais,
}: {
  etapas: Etapa[];
  contatosIniciais: Contato[];
}) {
  // Cliente Supabase do browser, estável entre renders.
  const [supabase] = useState(() => createClient());
  const [contatos, setContatos] = useState<Contato[]>(contatosIniciais);
  const [erro, setErro] = useState<string | null>(null);

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

  return (
    <div className="flex flex-1 flex-col">
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
              />
            ))}
          </div>
        </DndContext>
      )}
    </div>
  );
}

function Coluna({
  id,
  nome,
  contatos,
}: {
  id: string;
  nome: string;
  contatos: Contato[];
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
        <h2 className="text-sm font-semibold">{nome}</h2>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-foreground/50">
          {contatos.length}
        </span>
      </header>

      <div className="flex min-h-24 flex-1 flex-col gap-2 px-3 pb-3">
        {contatos.map((c) => (
          <Cartao key={c.id} contato={c} />
        ))}
      </div>
    </section>
  );
}

function Cartao({ contato }: { contato: Contato }) {
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
      {...listeners}
      {...attributes}
      className="cursor-grab touch-none rounded-lg border border-[#243029] bg-[#141D18] px-3 py-2.5 active:cursor-grabbing"
    >
      <p className="text-sm font-medium text-foreground">
        {contato.nome ?? "Sem nome"}
      </p>
      <p className="mt-0.5 text-xs text-foreground/50">{contato.telefone}</p>
    </article>
  );
}
