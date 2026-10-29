"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Provider = "google"; // | "github";

export function LoginButtons() {
  const params = useSearchParams();
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = params.get("next") ?? "/";

  async function signIn(provider: Provider) {
    setPending(provider);
    setError(null);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await createClient().auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });
    if (error) {
      setError(error.message);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button className="btn w-full py-2" disabled={pending !== null} onClick={() => signIn("google")}>
        {pending === "google" ? "Redirecting…" : "Continue with Google"}
      </button>
      {/* <button className="btn w-full py-2" disabled={pending !== null} onClick={() => signIn("github")}>
        {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
      </button> */}
      {(error || params.get("error")) && (
        <p className="text-sm text-ask">{error ?? "Sign-in failed. Please try again."}</p>
      )}
    </div>
  );
}
