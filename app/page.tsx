import { redirect } from "next/navigation";

// A raiz não tem conteúdo próprio: manda para /inicio. O proxy redireciona
// para /login caso o usuário não esteja autenticado.
export default function Home() {
  redirect("/inicio");
}
