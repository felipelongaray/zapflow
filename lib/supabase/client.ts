import { createBrowserClient } from "@supabase/ssr";

// Cliente Supabase para uso no BROWSER (Client Components).
// Usa as variáveis públicas NEXT_PUBLIC_* — a anon key pode ir para o client
// porque o acesso aos dados é protegido pelo RLS no Postgres.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
