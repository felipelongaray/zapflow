"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Conversa = {
  id: string;
  contatoNome: string | null;
  contatoTelefone: string | null;
  ultimaMensagemEm: string;
};

export type TipoMensagem =
  | "texto"
  | "imagem"
  | "audio"
  | "video"
  | "documento"
  | "sticker";

export type Mensagem = {
  id: string;
  conversaId: string;
  direcao: "entrada" | "saida";
  tipo: TipoMensagem;
  conteudo: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaNome: string | null;
  mediaTamanho: number | null;
  status: string | null;
  createdAt: string;
};

type MensagemRowDb = {
  id: string;
  conversa_id: string;
  direcao: "entrada" | "saida";
  tipo?: string | null;
  conteudo?: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  media_nome?: string | null;
  media_tamanho?: number | null;
  status?: string | null;
  created_at: string;
};

/** Mapeia linha do banco/realtime (snake_case) → Mensagem (camelCase). Mesmo shape do SSR. */
function mapearMensagemRow(row: MensagemRowDb): Mensagem {
  return {
    id: row.id,
    conversaId: row.conversa_id,
    direcao: row.direcao,
    tipo: (row.tipo as TipoMensagem) ?? "texto",
    conteudo: row.conteudo ?? "",
    mediaUrl: row.media_url ?? null,
    mediaMime: row.media_mime ?? null,
    mediaNome: row.media_nome ?? null,
    mediaTamanho: row.media_tamanho ?? null,
    status: row.status ?? null,
    createdAt: row.created_at,
  };
}

export function ConversasClient({
  conversasIniciais,
  mensagensIniciais,
}: {
  conversasIniciais: Conversa[];
  mensagensIniciais: Mensagem[];
}) {
  const [conversas, setConversas] = useState<Conversa[]>(conversasIniciais);
  const [mensagens, setMensagens] = useState<Mensagem[]>(mensagensIniciais);
  const [selecionada, setSelecionada] = useState<string | null>(
    conversasIniciais[0]?.id ?? null,
  );
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // HIDRATAÇÃO: os horários são formatados com locale/timezone (toLocale*), que
  // diferem entre o SERVIDOR (UTC na Vercel) e o BROWSER (TZ local, ex.: BRT).
  // Renderizar isso no SSR gera "text content mismatch" (React #418) ao hidratar
  // EM PRODUÇÃO — em dev não aparece porque server e browser são a mesma máquina
  // (mesmo fuso). Só formatamos a hora APÓS montar no cliente: assim o servidor e
  // o 1º render do cliente produzem o MESMO HTML, e o mismatch deixa de existir.
  const [montado, setMontado] = useState(false);

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
  // Continua disparando quando a contagem de mensagensDaConversa muda — inclusive
  // para as mensagens que chegam via Realtime.
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: "auto" });
  }, [selecionada, mensagensDaConversa.length]);

  // Marca que já montou no cliente — habilita a formatação de hora (ver acima).
  useEffect(() => {
    setMontado(true);
  }, []);

  // Cliente de SESSÃO do browser: anon key + JWT do usuário (cookies). O Realtime
  // roda sob esse JWT, então o RLS de `mensagens` filtra os eventos por
  // empresa_id — o browser só recebe INSERTs do próprio tenant e NUNCA usa
  // service_role. Criado uma única vez (inicializador do useState) para manter a
  // referência estável entre renders.
  const [supabase] = useState(() => createClient());

  // REALTIME: ouve INSERTs em public.mensagens (já incluída na publication
  // supabase_realtime + replica identity full pela migration 015, feita fora deste
  // fluxo) e injeta a mensagem nova no estado, sem reload. Cobre tanto as
  // RECEBIDAS via webhook quanto as ENVIADAS (que também voltam pelo INSERT).
  useEffect(() => {
    const channel = supabase
      .channel("mensagens-inserts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mensagens" },
        (payload) => {
          const nova = mapearMensagemRow(payload.new as MensagemRowDb);

          setMensagens((prev) => {
            // 1) Já temos a mensagem pelo ID real (a reconciliação do envio
            //    otimista já rodou): não duplica.
            if (prev.some((m) => m.id === nova.id)) return prev;

            // 2) Corrida: o evento Realtime chegou ANTES da resposta da rota de
            //    envio reconciliar o provisório. Casa o otimista ainda não
            //    reconciliado (id "temp-", mesma conversa/direção/conteúdo) e o
            //    substitui no lugar — em vez de adicionar uma segunda cópia.
            const idxProvisorio = prev.findIndex(
              (m) =>
                m.id.startsWith("temp-") &&
                m.conversaId === nova.conversaId &&
                m.direcao === nova.direcao &&
                m.conteudo === nova.conteudo,
            );
            if (idxProvisorio !== -1) {
              const copia = [...prev];
              copia[idxProvisorio] = nova;
              return copia;
            }

            // 3) Mensagem genuinamente nova (recebida via webhook, ou enviada de
            //    outra aba/sessão): adiciona.
            return [...prev, nova];
          });
        },
      )
      .subscribe();

    // Cleanup OBRIGATÓRIO: sem remover o channel, remontagens/navegação acumulam
    // subscriptions e os eventos passam a chegar (e duplicar) várias vezes.
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

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
      tipo: "texto",
      conteudo,
      mediaUrl: null,
      mediaMime: null,
      mediaNome: null,
      mediaTamanho: null,
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

    // >>> INTEGRAÇÃO REAL DO WHATSAPP <<<
    // O envio acontece NO SERVIDOR (Route Handler), nunca aqui: é lá que o
    // access_token do canal é lido e a Graph API do Meta é chamada. O cliente só
    // dispara a ação e renderiza o resultado — o token nunca chega ao browser.
    // O servidor também valida a empresa (RLS) e a janela de 24h.
    let resposta: Response;
    try {
      resposta = await fetch(`/api/conversas/${conversaId}/enviar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conteudo }),
      });
    } catch {
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      setErro("Falha de conexão. Tente novamente.");
      setEnviando(false);
      return;
    }

    if (!resposta.ok) {
      // Rollback do otimista e mensagem amigável (inclui o caso da janela de 24h
      // fechada, que vem com status 422 do servidor).
      const dados = await resposta.json().catch(() => ({}));
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      setErro(dados.error ?? "Não foi possível enviar a mensagem.");
      setEnviando(false);
      return;
    }

    const { mensagem } = await resposta.json();

    // Reconcilia o otimista com a mensagem real persistida pelo servidor.
    const real: Mensagem = {
      id: mensagem.id,
      conversaId: mensagem.conversaId,
      direcao: mensagem.direcao,
      tipo: (mensagem.tipo as TipoMensagem) ?? "texto",
      conteudo: mensagem.conteudo ?? "",
      mediaUrl: mensagem.mediaUrl ?? null,
      mediaMime: mensagem.mediaMime ?? null,
      mediaNome: mensagem.mediaNome ?? null,
      mediaTamanho: mensagem.mediaTamanho ?? null,
      status: mensagem.status ?? null,
      createdAt: mensagem.createdAt,
    };
    setMensagens((prev) => {
      // Se o evento Realtime já injetou a versão real desta mensagem (corrida em
      // que o INSERT chegou antes desta resposta), apenas descarta o provisório.
      // Caso contrário, troca o temp pelo real. Em ambos os casos não duplica.
      if (prev.some((m) => m.id === real.id)) {
        return prev.filter((m) => m.id !== tempId);
      }
      return prev.map((m) => (m.id === tempId ? real : m));
    });
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
                        {montado ? formatarHora(c.ultimaMensagemEm) : ""}
                      </span>
                    </div>
                    <p className="truncate text-sm text-muted">
                      {previa
                        ? `${previa.direcao === "saida" ? "Você: " : ""}${textoPrevia(previa)}`
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
                  <Balao key={m.id} mensagem={m} montado={montado} />
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

function Balao({
  mensagem,
  montado,
}: {
  mensagem: Mensagem;
  montado: boolean;
}) {
  const saida = mensagem.direcao === "saida";
  const urlMidia = mensagem.mediaUrl
    ? `/api/midia/${mensagem.mediaUrl}`
    : null;

  if (mensagem.tipo === "sticker") {
    return (
      <div className={`flex ${saida ? "justify-end" : "justify-start"}`}>
        <div className="max-w-[80%]">
          {urlMidia ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={urlMidia}
              alt="Figurinha"
              loading="lazy"
              className="h-32 w-32 object-contain"
            />
          ) : (
            <PlaceholderMidia caption={mensagem.conteudo} saida={saida} />
          )}
          <p
            className={`mt-1 text-right text-[10px] ${
              saida ? "text-muted" : "text-muted"
            }`}
          >
            {montado ? formatarHora(mensagem.createdAt) : ""}
          </p>
        </div>
      </div>
    );
  }

  const classesBalao = `max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
    saida
      ? "rounded-br-sm bg-primary text-primary-foreground"
      : "rounded-bl-sm border border-border bg-surface text-foreground"
  }`;

  const classesHora = `mt-1 text-right text-[10px] ${
    saida ? "text-primary-foreground/70" : "text-muted"
  }`;

  const classesCaption = `whitespace-pre-wrap break-words ${
    mensagem.tipo !== "texto" ? "mt-2" : ""
  }`;

  function ConteudoMidia() {
    if (mensagem.tipo === "texto") {
      return (
        <p className="whitespace-pre-wrap break-words">{mensagem.conteudo}</p>
      );
    }

    if (!urlMidia) {
      return <PlaceholderMidia caption={mensagem.conteudo} saida={saida} />;
    }

    switch (mensagem.tipo) {
      case "imagem":
        return (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={urlMidia}
              alt=""
              loading="lazy"
              className="max-h-64 max-w-full rounded-lg object-contain"
            />
            {mensagem.conteudo.trim() && (
              <p className={classesCaption}>{mensagem.conteudo}</p>
            )}
          </>
        );
      case "video":
        return (
          <>
            <video
              controls
              src={urlMidia}
              className="max-h-64 max-w-full rounded-lg"
            />
            {mensagem.conteudo.trim() && (
              <p className={classesCaption}>{mensagem.conteudo}</p>
            )}
          </>
        );
      case "audio":
        return (
          <audio controls src={urlMidia} className="min-w-[200px] w-full" />
        );
      case "documento":
        return (
          <>
            <a
              href={urlMidia}
              download={mensagem.mediaNome ?? true}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition ${
                saida
                  ? "border-primary-foreground/30 hover:bg-primary-foreground/10"
                  : "border-border hover:bg-primary-subtle/60"
              }`}
            >
              <span aria-hidden="true">📄</span>
              <span className="min-w-0 flex-1 truncate">
                {mensagem.mediaNome ?? "Documento"}
              </span>
              {mensagem.mediaTamanho != null && (
                <span className="shrink-0 text-xs opacity-70">
                  {formatarTamanho(mensagem.mediaTamanho)}
                </span>
              )}
            </a>
            {mensagem.conteudo.trim() && (
              <p className={classesCaption}>{mensagem.conteudo}</p>
            )}
          </>
        );
      default:
        return <PlaceholderMidia caption={mensagem.conteudo} saida={saida} />;
    }
  }

  return (
    <div className={`flex ${saida ? "justify-end" : "justify-start"}`}>
      <div className={classesBalao}>
        <ConteudoMidia />
        <p className={classesHora}>
          {montado ? formatarHora(mensagem.createdAt) : ""}
        </p>
      </div>
    </div>
  );
}

function PlaceholderMidia({
  caption,
  saida,
}: {
  caption: string;
  saida: boolean;
}) {
  return (
    <>
      <p
        className={`text-xs italic ${
          saida ? "text-primary-foreground/80" : "text-muted"
        }`}
      >
        [mídia indisponível]
      </p>
      {caption.trim() && (
        <p className="mt-1 whitespace-pre-wrap break-words">{caption}</p>
      )}
    </>
  );
}

function textoPrevia(m: Mensagem): string {
  if (m.conteudo.trim()) return m.conteudo;
  switch (m.tipo) {
    case "imagem":
      return "📷 Foto";
    case "audio":
      return "🎵 Áudio";
    case "video":
      return "🎥 Vídeo";
    case "documento":
      return "📄 Documento";
    case "sticker":
      return "Figurinha";
    default:
      return m.conteudo;
  }
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
