"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ACCEPT_MIDIA,
  type TipoMidiaEnvioClient,
  validarArquivoMidiaClient,
} from "@/lib/whatsapp/midia-limites-client";

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
  /** Key estável p/ React — não muda na reconciliação temp→real. */
  renderKey?: string;
  /** Blob local mantido até a mídia persistida (/api/midia) carregar. */
  previewBlobUrl?: string | null;
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

/** Casa mensagem otimista (temp-*) com INSERT do Realtime/resposta da rota. */
function casarProvisorioComNova(m: Mensagem, nova: Mensagem): boolean {
  if (!m.id.startsWith("temp-")) return false;
  if (m.conversaId !== nova.conversaId) return false;
  if (m.direcao !== nova.direcao) return false;
  if (m.tipo !== nova.tipo) return false;
  if (m.conteudo !== nova.conteudo) return false;
  if (
    m.mediaTamanho != null &&
    nova.mediaTamanho != null &&
    m.mediaTamanho !== nova.mediaTamanho
  ) {
    return false;
  }
  return true;
}

/** Mescla mensagem real com metadados do provisório (key estável + blob). */
function mesclarProvisorioComReal(
  provisorio: Mensagem,
  real: Mensagem,
): Mensagem {
  const blob =
    provisorio.previewBlobUrl ??
    (provisorio.mediaUrl?.startsWith("blob:")
      ? provisorio.mediaUrl
      : null);

  return {
    ...real,
    renderKey: provisorio.renderKey ?? provisorio.id,
    previewBlobUrl: blob,
  };
}

/** Reconcilia lista: troca temp pelo real ou mescla blob no real já inserido. */
function reconciliarListaComReal(
  prev: Mensagem[],
  tempId: string,
  real: Mensagem,
): Mensagem[] {
  const provisorio = prev.find((m) => m.id === tempId);
  if (!provisorio) {
    if (prev.some((m) => m.id === real.id)) return prev;
    return [...prev, real];
  }

  const mesclada = mesclarProvisorioComReal(provisorio, real);

  if (prev.some((m) => m.id === real.id && m.id !== tempId)) {
    return prev
      .filter((m) => m.id !== tempId)
      .map((m) => (m.id === real.id ? mesclarProvisorioComReal(provisorio, m) : m));
  }

  return prev.map((m) => (m.id === tempId ? mesclada : m));
}

type ArquivoPendente = {
  file: File;
  previewUrl: string;
  tipo: TipoMidiaEnvioClient;
};

/** Limites visuais compartilhados — imagem/vídeo no balão (entrada e saída). */
const CLASSE_MIDIA_VISUAL =
  "block h-auto max-h-64 w-auto max-w-full rounded-lg object-contain";

const CLASSE_MIDIA_WRAPPER =
  "block w-fit max-w-[18rem] shrink-0 overflow-hidden";

const MIME_GRAVACAO = "audio/mp4";

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
  const [arquivoPendente, setArquivoPendente] = useState<ArquivoPendente | null>(
    null,
  );
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [gravando, setGravando] = useState(false);
  const [segundosGravacao, setSegundosGravacao] = useState(0);
  const [suporteGravacao, setSuporteGravacao] = useState(false);

  // HIDRATAÇÃO: os horários são formatados com locale/timezone (toLocale*), que
  // diferem entre o SERVIDOR (UTC na Vercel) e o BROWSER (TZ local, ex.: BRT).
  // Renderizar isso no SSR gera "text content mismatch" (React #418) ao hidratar
  // EM PRODUÇÃO — em dev não aparece porque server e browser são a mesma máquina
  // (mesmo fuso). Só formatamos a hora APÓS montar no cliente: assim o servidor e
  // o 1º render do cliente produzem o MESMO HTML, e o mismatch deixa de existir.
  const [montado, setMontado] = useState(false);

  const fimRef = useRef<HTMLDivElement | null>(null);
  const inputArquivoRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamMicRef = useRef<MediaStream | null>(null);
  const chunksGravacaoRef = useRef<Blob[]>([]);
  const descartarGravacaoRef = useRef(false);

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
    setSuporteGravacao(
      typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(MIME_GRAVACAO),
    );
  }, []);

  function pararStreamMic() {
    streamMicRef.current?.getTracks().forEach((track) => track.stop());
    streamMicRef.current = null;
  }

  function encerrarGravacaoAtiva(descartar = true) {
    descartarGravacaoRef.current = descartar;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      pararStreamMic();
      chunksGravacaoRef.current = [];
      setGravando(false);
      setSegundosGravacao(0);
    }
    mediaRecorderRef.current = null;
  }

  useEffect(() => {
    if (!gravando) return;
    const id = window.setInterval(() => {
      setSegundosGravacao((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [gravando]);

  useEffect(() => {
    return () => {
      encerrarGravacaoAtiva(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup só no unmount
  }, []);

  // Limpa anexo pendente e gravação ao trocar de conversa.
  useEffect(() => {
    encerrarGravacaoAtiva(true);
    setArquivoPendente((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setTexto("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao trocar conversa
  }, [selecionada]);

  // Cliente de SESSÃO do browser: anon key + JWT do usuário (cookies). O Realtime
  // roda sob esse JWT, então o RLS de `mensagens` filtra os eventos por
  // empresa_id — o browser só recebe INSERTs do próprio tenant e NUNCA usa
  // service_role. Criado uma única vez (inicializador do useState) para manter a
  // referência estável entre renders.
  const [supabase] = useState(() => createClient());

  // REALTIME: INSERTs e UPDATEs em public.mensagens (publication 015 + replica
  // identity full). INSERT: nova mensagem / reconciliação otimista. UPDATE: status
  // entregue/lida ao vivo (webhook processarStatuses).
  useEffect(() => {
    const channel = supabase
      .channel("mensagens-realtime")
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
            const idxProvisorio = prev.findIndex((m) =>
              casarProvisorioComNova(m, nova),
            );
            if (idxProvisorio !== -1) {
              const copia = [...prev];
              copia[idxProvisorio] = mesclarProvisorioComReal(
                copia[idxProvisorio],
                nova,
              );
              return copia;
            }

            // 3) Mensagem genuinamente nova (recebida via webhook, ou enviada de
            //    outra aba/sessão): adiciona.
            return [...prev, nova];
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "mensagens" },
        (payload) => {
          const atualizada = mapearMensagemRow(payload.new as MensagemRowDb);

          setMensagens((prev) => {
            const idx = prev.findIndex((m) => m.id === atualizada.id);
            if (idx === -1) return prev;

            const anterior = prev[idx];
            const copia = [...prev];
            // Merge: campos do banco + metadados só do client (key estável, blob).
            copia[idx] = {
              ...atualizada,
              renderKey: anterior.renderKey,
              previewBlobUrl: anterior.previewBlobUrl,
            };
            return copia;
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
    if (!selecionada || enviando) return;

    if (arquivoPendente) {
      await enviarMidia(arquivoPendente);
      return;
    }

    const conteudo = texto.trim();
    if (!conteudo) return;

    const conversaId = selecionada;
    const agora = new Date().toISOString();

    // Atualização OTIMISTA: a mensagem aparece na hora com um id temporário.
    const tempId = `temp-${crypto.randomUUID()}`;
    const otimista: Mensagem = {
      id: tempId,
      renderKey: tempId,
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
    setMensagens((prev) => reconciliarListaComReal(prev, tempId, real));
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId
          ? { ...c, ultimaMensagemEm: real.createdAt }
          : c,
      ),
    );

    setEnviando(false);
  }

  async function enviarMidia(pendente: ArquivoPendente) {
    if (!selecionada || enviando) return;

    const { file: arquivo, previewUrl, tipo } = pendente;
    const conversaId = selecionada;
    const caption =
      tipo === "audio" ? "" : texto.trim();
    const legenda = caption || null;
    const agora = new Date().toISOString();
    const tempId = `temp-${crypto.randomUUID()}`;

    setArquivoPendente(null);
    setTexto("");
    setErro(null);
    setEnviando(true);

    const otimista: Mensagem = {
      id: tempId,
      renderKey: tempId,
      conversaId,
      direcao: "saida",
      tipo,
      conteudo: caption,
      mediaUrl: null,
      previewBlobUrl: previewUrl,
      mediaMime: arquivo.type.split(";")[0].trim().toLowerCase(),
      mediaNome: tipo === "documento" ? arquivo.name || "Documento" : null,
      mediaTamanho: arquivo.size,
      status: "enviada",
      createdAt: agora,
    };

    setMensagens((prev) => [...prev, otimista]);
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId ? { ...c, ultimaMensagemEm: agora } : c,
      ),
    );

    const form = new FormData();
    form.append("arquivo", arquivo);
    if (legenda) form.append("legenda", legenda);

    let resposta: Response;
    try {
      resposta = await fetch(`/api/conversas/${conversaId}/enviar-midia`, {
        method: "POST",
        body: form,
      });
    } catch {
      URL.revokeObjectURL(previewUrl);
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      setErro("Falha de conexão. Tente novamente.");
      setEnviando(false);
      return;
    }

    if (!resposta.ok) {
      URL.revokeObjectURL(previewUrl);
      const dados = await resposta.json().catch(() => ({}));
      setMensagens((prev) => prev.filter((m) => m.id !== tempId));
      setErro(dados.error ?? "Não foi possível enviar a mídia.");
      setEnviando(false);
      return;
    }

    const { mensagem } = await resposta.json();

    const real: Mensagem = {
      id: mensagem.id,
      conversaId: mensagem.conversaId,
      direcao: mensagem.direcao,
      tipo: (mensagem.tipo as TipoMensagem) ?? tipo,
      conteudo: mensagem.conteudo ?? "",
      mediaUrl: mensagem.mediaUrl ?? null,
      mediaMime: mensagem.mediaMime ?? null,
      mediaNome: mensagem.mediaNome ?? null,
      mediaTamanho: mensagem.mediaTamanho ?? null,
      status: mensagem.status ?? null,
      createdAt: mensagem.createdAt,
    };

    setMensagens((prev) => reconciliarListaComReal(prev, tempId, real));
    setConversas((prev) =>
      prev.map((c) =>
        c.id === conversaId
          ? { ...c, ultimaMensagemEm: real.createdAt }
          : c,
      ),
    );
    setEnviando(false);
  }

  function cancelarAnexo() {
    if (arquivoPendente?.previewUrl) {
      URL.revokeObjectURL(arquivoPendente.previewUrl);
    }
    setArquivoPendente(null);
    setTexto("");
    setErro(null);
  }

  async function iniciarGravacao() {
    if (!selecionada || enviando || gravando || arquivoPendente) return;
    if (!suporteGravacao) {
      setErro("Gravação de voz não suportada neste navegador.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamMicRef.current = stream;
      chunksGravacaoRef.current = [];
      descartarGravacaoRef.current = false;

      const recorder = new MediaRecorder(stream, {
        mimeType: MIME_GRAVACAO,
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksGravacaoRef.current.push(event.data);
      };

      recorder.onstop = () => {
        pararStreamMic();
        mediaRecorderRef.current = null;
        setGravando(false);
        setSegundosGravacao(0);

        if (descartarGravacaoRef.current) {
          descartarGravacaoRef.current = false;
          chunksGravacaoRef.current = [];
          return;
        }

        const blob = new Blob(chunksGravacaoRef.current, { type: "audio/mp4" });
        chunksGravacaoRef.current = [];

        if (blob.size === 0) {
          setErro("Gravação vazia. Tente novamente.");
          return;
        }

        const file = new File([blob], `audio-${Date.now()}.m4a`, {
          type: "audio/mp4",
        });
        const previewUrl = URL.createObjectURL(blob);

        setArquivoPendente((prev) => {
          if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
          return { file, previewUrl, tipo: "audio" };
        });
        setErro(null);
      };

      recorder.onerror = () => {
        encerrarGravacaoAtiva(true);
        setErro("Falha na gravação. Tente novamente.");
      };

      recorder.start();
      setGravando(true);
      setSegundosGravacao(0);
      setErro(null);
    } catch {
      pararStreamMic();
      setErro("Permissão do microfone negada ou indisponível.");
    }
  }

  function pararGravacao() {
    if (
      !mediaRecorderRef.current ||
      mediaRecorderRef.current.state !== "recording"
    ) {
      return;
    }
    descartarGravacaoRef.current = false;
    mediaRecorderRef.current.stop();
  }

  function cancelarGravacao() {
    if (!gravando) return;
    encerrarGravacaoAtiva(true);
  }

  function aoSelecionarArquivo(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivo = e.target.files?.[0];
    e.target.value = "";
    if (!arquivo) return;

    const validacao = validarArquivoMidiaClient(arquivo);
    if (!validacao.ok) {
      setErro(validacao.erro);
      return;
    }

    setErro(null);
    setArquivoPendente((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return {
        file: arquivo,
        previewUrl: URL.createObjectURL(arquivo),
        tipo: validacao.tipo,
      };
    });
  }

  const legendaDesabilitada =
    arquivoPendente?.tipo === "audio";
  const podeEnviar = gravando
    ? false
    : arquivoPendente
      ? !enviando
      : !!texto.trim() && !enviando;

  const consumirPreviewBlob = useCallback((renderKey: string) => {
    setMensagens((prev) =>
      prev.map((m) =>
        m.renderKey === renderKey ? { ...m, previewBlobUrl: null } : m,
      ),
    );
  }, []);

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
                  <Balao
                    key={m.renderKey ?? m.id}
                    mensagem={m}
                    montado={montado}
                    onPreviewBlobConsumido={consumirPreviewBlob}
                  />
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
            <div className="shrink-0 border-t border-border bg-surface">
              {gravando && (
                <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm">
                  <span
                    className="size-2 shrink-0 animate-pulse rounded-full bg-danger"
                    aria-hidden="true"
                  />
                  <span className="tabular-nums font-medium text-danger">
                    {formatarTempoGravacao(segundosGravacao)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    Gravando...
                  </span>
                  <button
                    type="button"
                    onClick={cancelarGravacao}
                    className="shrink-0 text-xs text-muted transition hover:text-foreground"
                  >
                    Cancelar
                  </button>
                </div>
              )}
              {arquivoPendente && (
                <PreviewAnexo
                  pendente={arquivoPendente}
                  onCancelar={cancelarAnexo}
                />
              )}
              <form
                onSubmit={enviar}
                className="flex items-center gap-2 px-4 py-3"
              >
                <input
                  ref={inputArquivoRef}
                  type="file"
                  accept={ACCEPT_MIDIA}
                  onChange={aoSelecionarArquivo}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => inputArquivoRef.current?.click()}
                  disabled={enviando || gravando}
                  aria-label="Anexar arquivo"
                  className="shrink-0 rounded-full p-2.5 text-muted transition hover:bg-primary-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <IconeAnexo />
                </button>
                <button
                  type="button"
                  onClick={gravando ? pararGravacao : iniciarGravacao}
                  disabled={
                    enviando ||
                    (!gravando && (!suporteGravacao || !!arquivoPendente))
                  }
                  title={
                    !suporteGravacao && !gravando
                      ? "Gravação não suportada neste navegador"
                      : undefined
                  }
                  aria-label={gravando ? "Parar gravação" : "Gravar áudio"}
                  className={`shrink-0 rounded-full p-2.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    gravando
                      ? "bg-danger-subtle text-danger hover:bg-danger/20"
                      : "text-muted hover:bg-primary-subtle hover:text-foreground"
                  }`}
                >
                  {gravando ? <IconeParar /> : <IconeMicrofone />}
                </button>
                <input
                  type="text"
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder={
                    arquivoPendente
                      ? legendaDesabilitada
                        ? "Áudio pronto para enviar"
                        : "Adicione uma legenda..."
                      : "Digite uma mensagem"
                  }
                  disabled={enviando || legendaDesabilitada || gravando}
                  className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!podeEnviar}
                  aria-label="Enviar"
                  className="shrink-0 rounded-full bg-primary p-2.5 text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <IconeEnviar />
                </button>
              </form>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Balao({
  mensagem,
  montado,
  onPreviewBlobConsumido,
}: {
  mensagem: Mensagem;
  montado: boolean;
  onPreviewBlobConsumido?: (renderKey: string) => void;
}) {
  const saida = mensagem.direcao === "saida";
  const urlPersistida =
    mensagem.mediaUrl && !mensagem.mediaUrl.startsWith("blob:")
      ? `/api/midia/${mensagem.mediaUrl}`
      : null;
  const blobUrl =
    mensagem.previewBlobUrl ??
    (mensagem.mediaUrl?.startsWith("blob:") ? mensagem.mediaUrl : null);
  const renderKey = mensagem.renderKey ?? mensagem.id;

  if (mensagem.tipo === "sticker") {
    const urlMidia = urlPersistida ?? blobUrl;
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
          <RodapeBalao
            mensagem={mensagem}
            montado={montado}
            classesHora={`mt-1 text-right text-[10px] ${
              saida ? "text-muted" : "text-muted"
            }`}
          />
        </div>
      </div>
    );
  }

  const ehMidiaVisual =
    mensagem.tipo === "imagem" || mensagem.tipo === "video";

  const classesBalao = `${
    ehMidiaVisual ? "w-fit" : "max-w-[80%]"
  } min-w-0 rounded-2xl px-3 py-2 text-sm shadow-sm ${
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

  function conteudoMidia() {
    if (mensagem.tipo === "texto") {
      return (
        <p className="whitespace-pre-wrap break-words">{mensagem.conteudo}</p>
      );
    }

    if (!urlPersistida && !blobUrl) {
      return <PlaceholderMidia caption={mensagem.conteudo} saida={saida} />;
    }

    switch (mensagem.tipo) {
      case "imagem":
        return (
          <>
            <ImagemMidiaBalao
              urlPersistida={urlPersistida}
              blobUrl={blobUrl}
              renderKey={renderKey}
              onBlobConsumido={onPreviewBlobConsumido}
            />
            {mensagem.conteudo.trim() && (
              <p className={classesCaption}>{mensagem.conteudo}</p>
            )}
          </>
        );
      case "video":
        return (
          <>
            <VideoMidiaBalao
              urlPersistida={urlPersistida}
              blobUrl={blobUrl}
              renderKey={renderKey}
              onBlobConsumido={onPreviewBlobConsumido}
            />
            {mensagem.conteudo.trim() && (
              <p className={classesCaption}>{mensagem.conteudo}</p>
            )}
          </>
        );
      case "audio":
        return (
          <AudioMidiaBalao
            urlPersistida={urlPersistida}
            blobUrl={blobUrl}
            renderKey={renderKey}
            onBlobConsumido={onPreviewBlobConsumido}
          />
        );
      case "documento":
        return (
          <>
            <DocumentoMidiaBalao
              urlPersistida={urlPersistida}
              blobUrl={blobUrl}
              nome={mensagem.mediaNome}
              tamanho={mensagem.mediaTamanho}
              saida={saida}
              renderKey={renderKey}
              onBlobConsumido={onPreviewBlobConsumido}
            />
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
        {conteudoMidia()}
        <RodapeBalao
          mensagem={mensagem}
          montado={montado}
          classesHora={classesHora}
        />
      </div>
    </div>
  );
}

/** Horário + indicador de status (só mensagens de saída). */
function RodapeBalao({
  mensagem,
  montado,
  classesHora,
}: {
  mensagem: Mensagem;
  montado: boolean;
  classesHora: string;
}) {
  const saida = mensagem.direcao === "saida";

  return (
    <p className={`${classesHora} flex items-center justify-end gap-1`}>
      {montado ? (
        <>
          <span>{formatarHora(mensagem.createdAt)}</span>
          {saida && <IndicadorStatus status={mensagem.status} />}
        </>
      ) : null}
    </p>
  );
}

function IndicadorStatus({ status }: { status: string | null }) {
  switch (status) {
    case "enviada":
      return (
        <span className="opacity-70" aria-label="Enviada">
          ✓
        </span>
      );
    case "entregue":
      return (
        <span className="opacity-70" aria-label="Entregue">
          ✓✓
        </span>
      );
    case "lida":
      return (
        <span className="text-sky-200" aria-label="Lida">
          ✓✓
        </span>
      );
    case "falhou":
      return (
        <span className="text-red-300" aria-label="Falhou">
          ⚠
        </span>
      );
    default:
      return null;
  }
}

/** Pré-carrega URL persistida; mantém blob visível até estar pronta (anti-flicker). */
function useTransicaoMidia(
  urlPersistida: string | null,
  blobUrl: string | null,
  renderKey: string,
  tipo: "imagem" | "video" | "audio" | "documento",
  onBlobConsumido?: (renderKey: string) => void,
) {
  const [persistidaPronta, setPersistidaPronta] = useState(
    () => !urlPersistida || !blobUrl,
  );

  useEffect(() => {
    if (!urlPersistida || !blobUrl) {
      setPersistidaPronta(true);
      return;
    }

    setPersistidaPronta(false);
    let cancelado = false;

    const concluir = () => {
      if (cancelado) return;
      setPersistidaPronta(true);
      URL.revokeObjectURL(blobUrl);
      onBlobConsumido?.(renderKey);
    };

    if (tipo === "imagem") {
      const img = new Image();
      img.onload = concluir;
      img.onerror = concluir;
      img.src = urlPersistida;
      return () => {
        cancelado = true;
        img.onload = null;
        img.onerror = null;
      };
    }

    if (tipo === "video") {
      const el = document.createElement("video");
      el.preload = "auto";
      el.oncanplaythrough = concluir;
      el.onerror = concluir;
      el.src = urlPersistida;
      return () => {
        cancelado = true;
        el.oncanplaythrough = null;
        el.onerror = null;
        el.removeAttribute("src");
        el.load();
      };
    }

    if (tipo === "audio") {
      const el = document.createElement("audio");
      el.preload = "auto";
      el.oncanplaythrough = concluir;
      el.onerror = concluir;
      el.src = urlPersistida;
      return () => {
        cancelado = true;
        el.oncanplaythrough = null;
        el.onerror = null;
        el.removeAttribute("src");
        el.load();
      };
    }

    // documento: aquece o fetch antes de trocar o href
    fetch(urlPersistida, { method: "GET" })
      .then(concluir)
      .catch(concluir);

    return () => {
      cancelado = true;
    };
  }, [urlPersistida, blobUrl, renderKey, tipo, onBlobConsumido]);

  const srcVisivel =
    urlPersistida && persistidaPronta && blobUrl
      ? urlPersistida
      : blobUrl ?? urlPersistida;

  return { srcVisivel };
}

function ImagemMidiaBalao({
  urlPersistida,
  blobUrl,
  renderKey,
  onBlobConsumido,
}: {
  urlPersistida: string | null;
  blobUrl: string | null;
  renderKey: string;
  onBlobConsumido?: (renderKey: string) => void;
}) {
  const { srcVisivel } = useTransicaoMidia(
    urlPersistida,
    blobUrl,
    renderKey,
    "imagem",
    onBlobConsumido,
  );

  if (!srcVisivel) return null;

  return (
    <div className={CLASSE_MIDIA_WRAPPER}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={srcVisivel}
        alt=""
        decoding="async"
        className={CLASSE_MIDIA_VISUAL}
      />
    </div>
  );
}

function VideoMidiaBalao({
  urlPersistida,
  blobUrl,
  renderKey,
  onBlobConsumido,
}: {
  urlPersistida: string | null;
  blobUrl: string | null;
  renderKey: string;
  onBlobConsumido?: (renderKey: string) => void;
}) {
  const { srcVisivel } = useTransicaoMidia(
    urlPersistida,
    blobUrl,
    renderKey,
    "video",
    onBlobConsumido,
  );

  if (!srcVisivel) return null;

  return (
    <div className={CLASSE_MIDIA_WRAPPER}>
      <video controls src={srcVisivel} className={CLASSE_MIDIA_VISUAL} />
    </div>
  );
}

function AudioMidiaBalao({
  urlPersistida,
  blobUrl,
  renderKey,
  onBlobConsumido,
}: {
  urlPersistida: string | null;
  blobUrl: string | null;
  renderKey: string;
  onBlobConsumido?: (renderKey: string) => void;
}) {
  const { srcVisivel } = useTransicaoMidia(
    urlPersistida,
    blobUrl,
    renderKey,
    "audio",
    onBlobConsumido,
  );

  if (!srcVisivel) return null;

  return (
    <audio controls src={srcVisivel} className="min-w-[200px] w-full max-w-full" />
  );
}

function DocumentoMidiaBalao({
  urlPersistida,
  blobUrl,
  nome,
  tamanho,
  saida,
  renderKey,
  onBlobConsumido,
}: {
  urlPersistida: string | null;
  blobUrl: string | null;
  nome: string | null;
  tamanho: number | null;
  saida: boolean;
  renderKey: string;
  onBlobConsumido?: (renderKey: string) => void;
}) {
  const { srcVisivel } = useTransicaoMidia(
    urlPersistida,
    blobUrl,
    renderKey,
    "documento",
    onBlobConsumido,
  );

  if (!srcVisivel) return null;

  return (
    <a
      href={srcVisivel}
      download={nome ?? true}
      className={`flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 transition ${
        saida
          ? "border-primary-foreground/30 hover:bg-primary-foreground/10"
          : "border-border hover:bg-primary-subtle/60"
      }`}
    >
      <span aria-hidden="true">📄</span>
      <span className="min-w-0 flex-1 truncate">{nome ?? "Documento"}</span>
      {tamanho != null && (
        <span className="shrink-0 text-xs opacity-70">
          {formatarTamanho(tamanho)}
        </span>
      )}
    </a>
  );
}

function PreviewAnexo({
  pendente,
  onCancelar,
}: {
  pendente: ArquivoPendente;
  onCancelar: () => void;
}) {
  const { previewUrl, tipo, file } = pendente;

  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3">
      <div className="relative shrink-0">
        {tipo === "imagem" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt=""
            className="size-16 rounded-lg object-cover"
          />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-lg bg-primary-subtle text-2xl">
            {tipo === "video" && "🎥"}
            {tipo === "audio" && "🎵"}
            {tipo === "documento" && "📄"}
          </div>
        )}
        <button
          type="button"
          onClick={onCancelar}
          aria-label="Remover anexo"
          className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-xs text-background shadow"
        >
          ×
        </button>
      </div>
      <div className="min-w-0 flex-1 pt-1">
        {tipo !== "imagem" && (
          <p className="truncate text-sm font-medium">{file.name}</p>
        )}
        {tipo === "imagem" && (
          <p className="truncate text-sm text-muted">{file.name}</p>
        )}
        {tipo === "audio" && (
          <audio
            controls
            src={previewUrl}
            className="mt-2 h-8 w-full max-w-xs"
          />
        )}
        <p className="text-xs text-muted">{formatarTamanho(file.size)}</p>
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

function formatarTempoGravacao(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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

function IconeMicrofone() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function IconeParar() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function IconeAnexo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
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
