import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type Viewer = {
  id: string;
  profile: Tables<"profiles">;
  group: Tables<"groups"> | null;
};

/** The signed-in user with their profile and group, or null. Memoized per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (!id) return null;

  const [{ data: profile }, { data: membership }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", id).single(),
    supabase.from("group_members").select("groups(*)").eq("user_id", id).maybeSingle(),
  ]);
  if (!profile) return null;
  return { id, profile, group: membership?.groups ?? null };
});

/** For server actions: returns an authenticated client for an admin, or throws. */
export async function requireAdmin() {
  const viewer = await getViewer();
  if (!viewer?.profile.is_admin) throw new Error("Admins only");
  return { viewer, supabase: await createClient() };
}

/** For server actions: returns an authenticated client for a signed-in user, or throws. */
export async function requireViewer() {
  const viewer = await getViewer();
  if (!viewer) throw new Error("Sign in first");
  return { viewer, supabase: await createClient() };
}
