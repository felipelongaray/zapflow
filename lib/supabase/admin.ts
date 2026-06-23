// ⚠️  SERVER-ONLY — NÃO IMPORTE ESTE MÓDULO EM CLIENT COMPONENTS ⚠️
//
// Este módulo usa a SUPABASE_SERVICE_ROLE_KEY, que IGNORA RLS e triggers
// (é a chave-mestra do projeto). Se vazar para o browser, qualquer pessoa teria
// acesso total ao banco. A diretiva "server-only" abaixo faz o BUILD FALHAR se
// este arquivo for importado, direta ou indiretamente, em código de cliente.
import "server-only";

import { createClient } from "@supabase/supabase-js";

// A chave NÃO tem prefixo NEXT_PUBLIC_, portanto nunca é embutida no bundle do
// browser — só existe no ambiente do servidor (.env.local / variáveis de host).
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Variáveis de ambiente ausentes: NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  // Sem persistência/refresh de sessão: este cliente é stateless e por requisição.
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
