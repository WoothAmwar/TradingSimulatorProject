"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { isLanguage, type Language } from "@/lib/templates";
import type { ActionResult } from "./admin";

export async function joinGroup(token: string): Promise<ActionResult> {
  const { supabase } = await requireViewer();
  const { data: slug, error } = await supabase.rpc("join_group", { p_token: token });
  if (error) return { ok: false, error: error.message };
  redirect(`/g/${slug}`);
}

/** Saves a new immutable version of the group's code. `lobbyId` marks code for a static round. */
export async function saveSubmission(input: {
  groupId: string;
  title: string;
  language: Language;
  source: string;
  lobbyId?: string | null;
}): Promise<ActionResult> {
  try {
    const { viewer, supabase } = await requireViewer();
    if (!isLanguage(input.language)) {
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
        lobby_id: input.lobbyId ?? null,
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

/** Records a static-round score computed by the browser; returns the group's rank. */
export async function submitRoundScore(input: {
  lobbyId: string;
  submissionId: string;
  score: number;
  ticks: number;
  fills: number;
}): Promise<ActionResult> {
  try {
    const { supabase } = await requireViewer();
    if (!Number.isFinite(input.score)) throw new Error("The backtest did not produce a score");
    const { data, error } = await supabase.rpc("submit_round_score", {
      p_lobby: input.lobbyId,
      p_submission: input.submissionId,
      p_score: input.score,
      p_ticks: input.ticks,
      p_fills: input.fills,
    });
    if (error) throw new Error(error.message);
    refresh();
    return { ok: true, value: String(data) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteSubmission(submissionId: string): Promise<ActionResult> {
  const { supabase } = await requireViewer();
  const { error } = await supabase.from("submissions").delete().eq("id", submissionId);
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true };
}
