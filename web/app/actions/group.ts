"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { Constants, type Enums } from "@/lib/supabase/database.types";
import type { ActionResult } from "./admin";

export async function joinGroup(token: string): Promise<ActionResult> {
  const { supabase } = await requireViewer();
  const { data: slug, error } = await supabase.rpc("join_group", { p_token: token });
  if (error) return { ok: false, error: error.message };
  redirect(`/g/${slug}`);
}

export async function saveSubmission(input: {
  groupId: string;
  title: string;
  language: Enums<"bot_language">;
  source: string;
}): Promise<ActionResult> {
  try {
    const { viewer, supabase } = await requireViewer();
    if (!Constants.public.Enums.bot_language.includes(input.language)) {
      throw new Error("Unsupported language");
    }
    const title = input.title.trim().slice(0, 80) || "Untitled";
    const { data, error } = await supabase
      .from("submissions")
      .insert({
        group_id: input.groupId,
        author_id: viewer.id,
        title,
        language: input.language,
        source: input.source,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    refresh();
    return { ok: true, value: data.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setActiveSubmission(
  lobbyId: string,
  submissionId: string,
): Promise<ActionResult> {
  const { supabase } = await requireViewer();
  const { error } = await supabase.rpc("set_active_submission", {
    p_lobby: lobbyId,
    p_submission: submissionId,
  });
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}

export async function deleteSubmission(submissionId: string): Promise<ActionResult> {
  const { supabase } = await requireViewer();
  const { error } = await supabase.from("submissions").delete().eq("id", submissionId);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}
