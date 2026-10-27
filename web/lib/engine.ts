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

  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}/admin/lobbies/${lobbyId}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    throw new Error(`Engine unreachable at ${ENGINE_URL}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Engine returned ${res.status}`);
  }
}
