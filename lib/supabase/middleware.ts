import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Rota pública (sem autenticação). Toda outra rota exige login.
const ROTA_LOGIN = "/login";
// Rota inicial pós-login.
const ROTA_INICIO = "/inicio";

// Atualiza/renova a sessão do Supabase e aplica a proteção de rotas.
// Chamada pelo proxy.ts em toda requisição que casa com o matcher.
export async function updateSession(request: NextRequest) {
  // Resposta base que vamos devolver quando a requisição puder seguir adiante.
  // É recriada dentro de setAll para carregar os cookies de sessão renovados.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANTE: use getUser() (valida o token no servidor do Supabase), nunca
  // getSession() para decisões de autorização. Não coloque código entre
  // createServerClient e getUser para evitar logouts difíceis de depurar.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const estaNoLogin = pathname === ROTA_LOGIN;

  // Não autenticado tentando acessar rota protegida -> manda para /login.
  if (!user && !estaNoLogin) {
    const url = request.nextUrl.clone();
    url.pathname = ROTA_LOGIN;
    return redirecionarPreservandoCookies(url, supabaseResponse);
  }

  // Autenticado tentando acessar /login -> manda para /inicio.
  if (user && estaNoLogin) {
    const url = request.nextUrl.clone();
    url.pathname = ROTA_INICIO;
    return redirecionarPreservandoCookies(url, supabaseResponse);
  }

  // Caso contrário, segue adiante com os cookies (possivelmente renovados).
  return supabaseResponse;
}

// Cria um redirect copiando os cookies de sessão já gravados em supabaseResponse,
// para não perder um token recém-renovado durante o redirecionamento.
function redirecionarPreservandoCookies(
  url: URL,
  supabaseResponse: NextResponse,
) {
  const response = NextResponse.redirect(url);
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });
  return response;
}
