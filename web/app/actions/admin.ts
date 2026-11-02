"use server";

import { refresh } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { callEngine, type LobbyAction } from "@/lib/engine";
import { GOOD_PRESETS, isStaticPreset, STATIC_PRESETS } from "@/lib/lobby";
import type { Enums, Json, TablesInsert } from "@/lib/supabase/database.types";

export type ActionResult = { ok: true; value?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const value = await fn();
    refresh();
    return { ok: true, value: value ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function intField(form: FormData, key: string, min: number, max: number, fallback: number) {
  const raw = form.get(key);
  const n = raw === null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// Groups ------------------------------------------------------------------------------------

export async function createGroup(form: FormData) {
  return run(async () => {
    const { viewer, supabase } = await requireAdmin();
    const name = String(form.get("name") ?? "").trim();
    const slug = slugify(String(form.get("slug") || name));
    if (!name || !slug) throw new Error("Group name is required");
    const { error } = await supabase
      .from("groups")
      .insert({ name, slug, created_by: viewer.id });
    if (error) throw new Error(error.code === "23505" ? `Slug "${slug}" is taken` : error.message);
  });
}

export async function rotateInvite(groupId: string) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { data, error } = await supabase.rpc("rotate_invite", { p_group: groupId });
    if (error) throw new Error(error.message);
    return data;
  });
}

export async function deleteGroup(groupId: string) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = await supabase.from("groups").delete().eq("id", groupId);
    if (error) throw new Error(error.message);
  });
}

export async function removeMember(groupId: string, userId: string) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = await supabase
      .from("group_members")
      .delete()
      .eq("group_id", groupId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  });
}

// Lobbies and static rounds -----------------------------------------------------------------

function seedField(form: FormData): string {
  const seed = String(form.get("seed") ?? "").trim();
  if (seed && (!/^\d{1,39}$/.test(seed) || BigInt(seed) >= 2n ** 128n)) {
    throw new Error("Seed must be an integer in [0, 2^128)");
  }
  return seed;
}

/** Inserts a lobby with its secrets row, removing the lobby again if the secrets insert fails. */
async function insertLobby(
  supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"],
  lobby: TablesInsert<"lobbies">,
  modelConfig: Json,
  seed: string,
) {
  const { data, error } = await supabase.from("lobbies").insert(lobby).select("id").single();
  if (error) throw new Error(error.message);

  // The engine resolves preset names into full model parameters; the seed column is
  // numeric(39), passed as a string so no precision is lost.
  const secret = {
    lobby_id: data.id,
    model_config: modelConfig,
    ...(seed ? { seed: seed as unknown as number } : {}),
  };
  const { error: secretError } = await supabase.from("lobby_secrets").insert(secret);
  if (secretError) {
    await supabase.from("lobbies").delete().eq("id", data.id);
    throw new Error(secretError.message);
  }
}

export async function createLobby(form: FormData) {
  return run(async () => {
    const { viewer, supabase } = await requireAdmin();
    const name = String(form.get("name") ?? "").trim();
    if (!name) throw new Error("Lobby name is required");
    const good = String(form.get("good") ?? "");
    if (!(good in GOOD_PRESETS)) throw new Error("Pick a good");
    const goods = [good]; // every lobby trades a single good
    const seed = seedField(form);
    const publicConfig = {
      goods,
      tick_ms: intField(form, "tick_ms", 200, 10_000, 1000),
      dataset_ticks: intField(form, "dataset_ticks", 100, 100_000, 10_000),
      live_ticks: intField(form, "live_ticks", 10, 100_000, 3_600),
    };
    await insertLobby(
      supabase,
      {
        name,
        kind: "live",
        max_groups: intField(form, "max_groups", 1, 200, 20),
        public_config: publicConfig,
        created_by: viewer.id,
      },
      { goods, overrides: {} },
      seed,
    );
  });
}

export async function createStaticRound(form: FormData) {
  return run(async () => {
    const { viewer, supabase } = await requireAdmin();
    const name = String(form.get("name") ?? "").trim();
    if (!name) throw new Error("Round name is required");
    const preset = String(form.get("preset") ?? "");
    if (!isStaticPreset(preset)) throw new Error("Pick a preset");
    const seed = seedField(form);
    const publicConfig = {
      preset,
      goods: [STATIC_PRESETS[preset].good],
      dataset_ticks: intField(form, "ticks", 10, 20_000, STATIC_PRESETS[preset].ticks),
    };
    await insertLobby(
      supabase,
      { name, kind: "static", public_config: publicConfig, created_by: viewer.id },
      { preset },
      seed,
    );
  });
}

export type StaticRoundAction = "open" | "pause" | "resume" | "close";

const STATIC_TRANSITIONS: Record<
  StaticRoundAction,
  { from: Enums<"lobby_status">[]; to: Enums<"lobby_status"> }
> = {
  open: { from: ["scheduled"], to: "running" },
  pause: { from: ["running"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  close: { from: ["running", "paused"], to: "finished" },
};

/** Opens, pauses or closes scoring for a static round. Static rounds have no engine runner, so
 * this is a status change only, independent of any live lobby. */
export async function staticRoundAction(lobbyId: string, action: StaticRoundAction) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { from, to } = STATIC_TRANSITIONS[action];
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("lobbies")
      .update({
        status: to,
        ...(action === "open" ? { started_at: now } : {}),
        ...(action === "close" ? { finished_at: now } : {}),
      })
      .eq("id", lobbyId)
      .eq("kind", "static")
      .in("status", from)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("The round's status changed; reload and try again");
  });
}

/** Live lobbies can be deleted unless they are running; static rounds in any status. */
export async function deleteLobby(lobbyId: string) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = await supabase
      .from("lobbies")
      .delete()
      .eq("id", lobbyId)
      .or("kind.eq.static,status.in.(draft,scheduled,finished)");
    if (error) throw new Error(error.message);
  });
}

export async function setLobbyEntry(lobbyId: string, groupId: string, entered: boolean) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = entered
      ? await supabase.from("lobby_entries").insert({ lobby_id: lobbyId, group_id: groupId })
      : await supabase
          .from("lobby_entries")
          .delete()
          .eq("lobby_id", lobbyId)
          .eq("group_id", groupId);
    if (error) throw new Error(error.message);
  });
}

export async function lobbyAction(lobbyId: string, action: LobbyAction) {
  return run(async () => {
    await requireAdmin();
    await callEngine(lobbyId, action);
  });
}

// Admins ------------------------------------------------------------------------------------

export async function setAdmin(userId: string, value: boolean) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = await supabase.rpc("set_admin", { p_user: userId, p_value: value });
    if (error) throw new Error(error.message);
  });
}

export async function addAllowlistEmail(form: FormData) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Enter a valid email");
    const { error } = await supabase.from("admin_allowlist").insert({ email });
    if (error && error.code !== "23505") throw new Error(error.message);
  });
}

export async function removeAllowlistEmail(email: string) {
  return run(async () => {
    const { supabase } = await requireAdmin();
    const { error } = await supabase.from("admin_allowlist").delete().eq("email", email);
    if (error) throw new Error(error.message);
  });
}
