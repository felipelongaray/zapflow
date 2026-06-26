"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Conversa = {
  id: string;
  contatoNome: string | null;
  contatoTelefone: string | null;
  ultimaMensagemEm: string;
};

export type Mensagem = {
  id: string;
  conversaId: string;
  direcao: "entrada" | "saida";
  conteudo: string;
  status: string | null;
  createdAt: string;
};

export function ConversasClient({
  empresaId,
  conversasIniciais,
  mensagensIniciais,
}: {
  empresaId: string;
  conversasIniciais: Conversa[];
  mensagensIniciais: Mensagem[];
}) {
  const [supabase] = useState(() => createClient());
  const [conversas, setConversas] = useState<Conversa[]>(conversasIniciais);
  const [mensagens, setMensagens] = useState<Mensagem[]>(mensagensIniciais);
  const [selecionada, setSelecionada] = useState<string | null>(
    conversasIniciais[0]?.id ?? null,
  );
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const fimRef = useRef<HTMLDivElement | null>(null);

  // Conversas sempre ordenadas pela mais recente (reflete envios novos).
  const conversasOrdenadas = useMemo(
    () =>
      [...conversas].sort(
        (a, b) =>
          new Date(b.ultimaMensagemEm).getTime() -
          new Date(a.ultimaMensagemEm).getTime(),
      ),
    [conversas],
  );

  const conversaAtual = conversasOrdenadas.find((c) => c.id === selecionada);

  const mensagensDaConversa = useMemo(
    () =>
      mensagens
        .filter((m) => m.conversaId === selecionada)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [mensagens, selecionada],
  );

  // Prévia (última mensagem) por conversa, para a lista da esquerda.
  const previaPorConversa = useMemo(() => {
    const mapa = new Map<string, Mensagem>();
    for (const m of mensagens) {
      const atual = mapa.get(m.conversaId);
      if (
        !atual ||
        new Date(m.createdAt).getTime() > new Date(atual.createdAt).getTime()
      ) {
        mapa.set(m.conversaId, m);
      }
    }
    return mapa;
  }, [mensagens]);

  // Rola para a mensagem mais recente ao trocar de conversa ou receber nova.
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: "auto" });
  }, [selecionada, mensagensDaConversa.length]);

  async function enviar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const conteudo = texto.trim();
    if (!conteudo || !selecionada || enviando) return;

    const conversaId = selecionada;
    const agora = new Date().toISOString();

    // Atualização OTIMISTA: a mensagem aparece na hora com um id temporário.
    const tempId = `temp-${crypto.randomUUID()}`;
    const otimista: Mensagem = {
      id: tempId,
      conversaId,
      direcao: "saida",
      conteudo,
      status: "enviada",
      createdAt: agora,
    };
    setMensagens((prev) => [...prev, otimista]);
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId ? { ...c, ultimaMensagemEm: agora } : c,
      ),
    );
    setTexto("");
    setErro(null);
    setEnviando(true);

    // Persiste no banco via cliente de SESSÃO. O RLS (WITH CHECK empresa_id =
    // get_minha_empresa()) garante que só dá para gravar na própria empresa;
    // empresa_id vem do perfil resolvido no servidor (prop), não do usuário.
    //
    // >>> INTEGRAÇÃO REAL DO WHATSAPP ENTRA AQUI <<<
    // Hoje a mensagem só é PERSISTIDA e exibida. No futuro, após o insert (ou via
    // um Route Handler no servidor), chamaríamos a API do provedor (ex.: Cloud
    // API / BSP) para de fato ENVIAR ao número do contato, e atualizaríamos
    // `status` conforme os callbacks (enviada -> entregue -> lida).
    const { data, error } = await supabase
      .from("mensagens")
      .insert({
        empresa_id: empresaId,
        conversa_id: conversaId,
        direcao: "saida",
        conteudo,
        status: "enviada",
      })
      .select("id, conversa_id, direcao, conteudo, status, created_at")
      .single();

    if (error || !data) {
      // Rollback do otimista.
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      setErro("Não foi possível enviar a mensagem. Tente novamente.");
      setEnviando(false);
      return;
    }

    // Reconcilia o id/timestamp reais.
    const real: Mensagem = {
      id: data.id as string,
      conversaId: data.conversa_id as string,
      direcao: data.direcao as "entrada" | "saida",
      conteudo: data.conteudo ?? "",
      status: (data.status as string) ?? null,
      createdAt: data.created_at as string,
    };
    setMensagens((prev) => prev.map((m) => (m.id === tempId ? real : m)));

    // Atualiza ultima_mensagem_em da conversa (ordenação da lista). RLS protege.
    await supabase
      .from("conversas")
      .update({ ultima_mensagem_em: real.createdAt })
      .eq("id", conversaId);
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId
          ? { ...c, ultimaMensagemEm: real.createdAt }
          : c,
      ),
    );

    setEnviando(false);
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* COLUNA ESQUERDA: lista de conversas. No mobile, some quando há uma
          conversa selecionada (mostra só a thread). */}
      <aside
        className={`${
          selecionada ? "hidden md:flex" : "flex"
        } w-full shrink-0 flex-col border-r border-border bg-surface md:w-80`}
      >
        <div className="shrink-0 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Conversas
          </h2>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {conversasOrdenadas.length === 0 && (
            <li className="px-4 py-6 text-sm text-muted">
              Nenhuma conversa ainda.
            </li>
          )}
          {conversasOrdenadas.map((c) => {
            const previa = previaPorConversa.get(c.id);
            const ativa = c.id === selecionada;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelecionada(c.id)}
                  className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition ${
                    ativa ? "bg-primary-subtle" : "hover:bg-primary-subtle/60"
                  }`}
                >
                  <Avatar nome={c.contatoNome} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate font-medium">
                        {c.contatoNome ?? c.contatoTelefone ?? "Sem nome"}
                      </p>
                      <span className="shrink-0 text-xs text-muted">
                        {formatarHora(c.ultimaMensagemEm)}
                      </span>
                    </div>
                    <p className="truncate text-sm text-muted">
                      {previa
                        ? `${previa.direcao === "saida" ? "Você: " : ""}${previa.conteudo}`
                        : "Sem mensagens"}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ÁREA PRINCIPAL: thread da conversa selecionada. */}
      <section
        className={`${
          selecionada ? "flex" : "hidden md:flex"
        } min-h-0 min-w-0 flex-1 flex-col bg-background`}
      >
        {!conversaAtual ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted">
            Selecione uma conversa para ver as mensagens.
          </div>
        ) : (
          <>
            {/* Cabeçalho da conversa */}
            <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3">
              <button
                type="button"
                onClick={() => setSelecionada(null)}
                aria-label="Voltar para a lista"
                className="rounded-md p-1.5 text-muted transition hover:bg-primary-subtle hover:text-foreground md:hidden"
              >
                <IconeVoltar />
              </button>
              <Avatar nome={conversaAtual.contatoNome} />
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {conversaAtual.contatoNome ??
                    conversaAtual.contatoTelefone ??
                    "Sem nome"}
                </p>
                {conversaAtual.contatoTelefone && (
                  <p className="truncate text-xs text-muted">
                    {conversaAtual.contatoTelefone}
                  </p>
                )}
              </div>
            </div>

            {/* Histórico de mensagens */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto flex max-w-2xl flex-col gap-2">
                {mensagensDaConversa.map((m) => (
                  <Balao key={m.id} mensagem={m} />
                ))}
                <div ref={fimRef} />
              </div>
            </div>

            {erro && (
              <p
                role="alert"
                className="mx-4 mb-2 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
              >
                {erro}
              </p>
            )}

            {/* Campo de resposta */}
            <form
              onSubmit={enviar}
              className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-3"
            >
              <input
                type="text"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Digite uma mensagem"
                className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              />
              <button
                type="submit"
                disabled={!texto.trim() || enviando}
                aria-label="Enviar"
                className="shrink-0 rounded-full bg-primary p-2.5 text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <IconeEnviar />
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

function Balao({ mensagem }: { mensagem: Mensagem }) {
  const saida = mensagem.direcao === "saida";
  return (
    <div className={`flex ${saida ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          saida
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border border-border bg-surface text-foreground"
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{mensagem.conteudo}</p>
        <p
          className={`mt-1 text-right text-[10px] ${
            saida ? "text-primary-foreground/70" : "text-muted"
          }`}
        >
          {formatarHora(mensagem.createdAt)}
        </p>
      </div>
    </div>
  );
}

function Avatar({ nome }: { nome: string | null }) {
  const inicial = (nome ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-sm font-semibold text-primary">
      {inicial}
    </span>
  );
}

// Formata o horário; mostra a data quando não for hoje (lista de conversas).
function formatarHora(iso: string) {
  const d = new Date(iso);
  const hoje = new Date();
  const mesmoDia =
    d.getFullYear() === hoje.getFullYear() &&
    d.getMonth() === hoje.getMonth() &&
    d.getDate() === hoje.getDate();
  if (mesmoDia) {
    return d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function IconeEnviar() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}

function IconeVoltar() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
