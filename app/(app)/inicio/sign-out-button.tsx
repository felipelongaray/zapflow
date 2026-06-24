"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [saindo, setSaindo] = useState(false);

  async function handleSignOut() {
    setSaindo(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={saindo}
      className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saindo ? "Saindo..." : "Sair"}
    </button>
  );
}
