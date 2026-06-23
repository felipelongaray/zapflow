import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Cliente Supabase para uso no SERVIDOR (Server Components, Route Handlers,
// Server Actions). No Next.js 16 `cookies()` é assíncrono, por isso a função
// é async e deve ser chamada com `await`.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // `setAll` foi chamado a partir de um Server Component, onde não é
            // possível escrever cookies. Pode ser ignorado com segurança: o
            // proxy (proxy.ts) é quem renova a sessão e grava os cookies.
          }
        },
      },
    },
  );
}
