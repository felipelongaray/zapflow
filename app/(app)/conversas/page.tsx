import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "../inicio/sign-out-button";
import {
  ConversasClient,
  type Conversa,
  type Mensagem,
} from "./conversas-client";

// Tela de conversa (estilo WhatsApp Web). Operação do CRM: acesso só para
// usuários COM empresa_id (superadmin gerencia, não opera -> /admin).
//
// SEGURANÇA / RLS: todas as leituras abaixo usam o cliente de SESSÃO. As policies
// de conversas/mensagens (migration 010) filtram por empresa_id = get_minha_empresa(),
// então a query já retorna SOMENTE os dados da empresa do usuário — não filtramos
// empresa_id na mão nem confiamos em nada vindo do cliente.
export default async function ConversasPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: perfil } = await supabase
    .from("perfis")
    .select("empresa_id, is_super_admin, papel")
    .eq("id", user.id)
    .single();

  if (perfil?.is_super_admin) redirect("/admin");
  if (!perfil?.empresa_id) redirect("/inicio");

  const ehDono = perfil.papel === "dono";

  // Lista de conversas: contato embutido (relação to-one conversas.contato_id ->
  // contatos.id). Ordenadas pela mais recente (índice conversas_empresa_ultima_msg_idx).
  const { data: conversasRaw } = await supabase
    .from("conversas")
    .select("id, ultima_mensagem_em, contato:contatos(nome, telefone)")
    .order("ultima_mensagem_em", { ascending: false });

  // Mensagens da empresa (RLS limita ao tenant). Para um volume de demo isto é
  // suficiente e evita N+1: o cliente agrupa por conversa e exibe na hora.
  const { data: mensagensRaw } = await supabase
    .from("mensagens")
    .select("id, conversa_id, direcao, conteudo, status, created_at")
    .order("created_at", { ascending: true });

  const conversas: Conversa[] = (conversasRaw ?? []).map((c) => {
    // O embed pode vir como objeto ou array dependendo da inferência; normaliza.
    const contato = Array.isArray(c.contato) ? c.contato[0] : c.contato;
    return {
      id: c.id as string,
      contatoNome: contato?.nome ?? null,
      contatoTelefone: contato?.telefone ?? null,
      ultimaMensagemEm: c.ultima_mensagem_em as string,
    };
  });

  const mensagens: Mensagem[] = (mensagensRaw ?? []).map((m) => ({
    id: m.id as string,
    conversaId: m.conversa_id as string,
    direcao: m.direcao as "entrada" | "saida",
    conteudo: m.conteudo ?? "",
    status: (m.status as string) ?? null,
    createdAt: m.created_at as string,
  }));

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-5 py-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight">
            zap<span className="text-primary">flow</span>
          </h1>
          <p className="text-xs text-muted">Conversas</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/funil"
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-primary-subtle"
          >
            Funil
          </Link>
          {ehDono && (
            <Link
              href="/equipe"
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition hover:bg-primary-subtle"
            >
              Equipe
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>

      <ConversasClient
        conversasIniciais={conversas}
        mensagensIniciais={mensagens}
      />
    </main>
  );
}
