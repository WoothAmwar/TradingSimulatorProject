import "server-only";

import { createClient } from "@/lib/supabase/server";

export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:8000";

export type LobbyAction = "prepare" | "start" | "pause" | "resume" | "stop";

/** Calls an engine admin endpoint with the signed-in user's access token. */
export async function callEngine(lobbyId: string, action: LobbyAction): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in first");

  // On Render's free plan the engine sleeps after 15 idle minutes and takes about a minute to wake.
  const waking = new Error(
    `The engine at ${ENGINE_URL} isn't responding yet. It sleeps when idle and takes about a minute to wake; try again shortly.`,
  );
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/admin/lobbies/${lobbyId}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    throw waking;
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok) return;
  if (body?.detail) throw new Error(body.detail);
  throw [502, 503, 504].includes(res.status) || res.ok ? waking : new Error(`Engine returned ${res.status}`);
}
