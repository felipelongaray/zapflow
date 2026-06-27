import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Proxy do Next.js 16 (antigo "middleware"). Roda antes de cada requisição que
// casa com o matcher e protege todas as rotas internas: sem sessão -> /login;
// com sessão acessando /login -> /inicio. Ver lib/supabase/middleware.ts.
//
// Runtime: o Proxy do Next.js 16 já roda em Node.js por padrão. A opção
// `runtime` NÃO é configurável aqui (defini-la lança erro), por isso não a
// declaramos — precisamos do runtime Node.js para o @supabase/ssr funcionar.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Casa com todas as rotas, EXCETO:
     * - api/webhooks (webhooks externos, ex.: Meta — não têm sessão de usuário e
     *   se autenticam por assinatura; não podem ser redirecionados para /login)
     * - _next/static (arquivos estáticos)
     * - _next/image (otimização de imagem)
     * - favicon.ico e arquivos de imagem comuns
     * Sem essas exclusões, a lógica de auth bloquearia CSS/JS/imagens/webhooks.
     */
    "/((?!api/webhooks|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
