import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getViewer } from "@/lib/auth";
import { publicConfig } from "@/lib/lobby";
import { createClient } from "@/lib/supabase/server";

/** Loads a group by slug for a member (or admin); everyone else gets a 404. */
export const getGroupContext = cache(async (slug: string) => {
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?next=/g/${slug}`);
  const supabase = await createClient();
  const { data: group } = await supabase.from("groups").select("*").eq("slug", slug).maybeSingle();
  if (!group) notFound();
  const isMember = viewer.group?.id === group.id;
  if (!isMember && !viewer.profile.is_admin) notFound();
  return { viewer, group, isMember, supabase };
});

/** Live lobbies this group is entered in, with each lobby's active submission. */
export async function getGroupLobbies(groupId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("lobby_entries")
    .select("active_submission_id, lobbies!inner(id, name, status, public_config)")
    .eq("group_id", groupId)
    .eq("lobbies.kind", "live");
  return (data ?? []).flatMap((e) =>
    e.lobbies ? [{ ...e.lobbies, activeSubmissionId: e.active_submission_id }] : [],
  );
}

/** Published static rounds, newest first. Every group may take part in each of them. */
export async function getStaticRounds() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("lobbies")
    .select("id, name, status, public_config")
    .eq("kind", "static")
    .neq("status", "draft")
    .order("created_at", { ascending: false });
  return (data ?? []).flatMap((l) => {
    const config = publicConfig(l.public_config);
    return config.preset ? [{ id: l.id, name: l.name, status: l.status, config, preset: config.preset }] : [];
  });
}

export type StaticRound = Awaited<ReturnType<typeof getStaticRounds>>[number];
