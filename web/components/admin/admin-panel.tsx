"use client";

import { useEffect, useState, useTransition } from "react";
import {
  addAllowlistEmail,
  createGroup,
  createLobby,
  createStaticRound,
  deleteGroup,
  deleteLobby,
  lobbyAction,
  removeAllowlistEmail,
  removeMember,
  rotateInvite,
  setAdmin,
  setLobbyEntry,
  staticRoundAction,
  type ActionResult,
  type StaticRoundAction,
} from "@/app/actions/admin";
import type { LobbyAction } from "@/lib/engine";
import { GOOD_PRESETS, STATIC_PRESETS, STATUS_STYLES, statusLabel, type PublicConfig } from "@/lib/lobby";
import { languageLabel } from "@/lib/templates";

export type AdminData = {
  viewerId: string;
  groups: {
    id: string;
    name: string;
    slug: string;
    token: string | null;
    members: { userId: string; name: string | null; email: string | null }[];
  }[];
  lobbies: {
    id: string;
    name: string;
    status: string;
    kind: string;
    max_groups: number;
    current_tick: number | null;
    config: PublicConfig;
    seed: string | null;
    /** Entered groups, each with its active submission (live rounds). */
    entries: { groupId: string; submission: { id: string; title: string; language: string } | null }[];
  }[];
  profiles: { id: string; display_name: string | null; email: string | null; is_admin: boolean }[];
  allowlist: string[];
};

/** Runs a server action, tracking pending state and the last error. */
function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const exec = (fn: () => Promise<ActionResult>, onOk?: (r: ActionResult) => void) =>
    start(async () => {
      const result = await fn();
      if (result.ok) {
        setError(null);
        onOk?.(result);
      } else setError(result.error);
    });
  return { pending, error, exec };
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="mt-2 text-sm text-ask">{error}</p> : null;
}

export function AdminPanel({ data, engineUrl }: { data: AdminData; engineUrl: string }) {
  // Wake the engine as soon as an admin opens the page: on Render's free plan it sleeps after
  // 15 idle minutes and takes about a minute to start, so lobby actions are ready by first click.
  useEffect(() => {
    fetch(`${engineUrl}/health`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
  }, [engineUrl]);

  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">
        Admin <span className="badge ml-2 bg-accent/15 text-accent">only visible to admins</span>
      </h2>
      <div className="grid gap-6 xl:grid-cols-2">
        <GroupsAdmin groups={data.groups} />
        <LobbiesAdmin lobbies={data.lobbies.filter((l) => l.kind === "live")} groups={data.groups} />
      </div>
      <StaticRoundsAdmin rounds={data.lobbies.filter((l) => l.kind === "static")} />
      <AdminsAdmin data={data} />
    </section>
  );
}

/** Invite codes are 8 characters, shown in two groups of four (K7QM-X2PD) so they are easy to type. */
const inviteCode = (token: string) => (token.length === 8 ? `${token.slice(0, 4)}-${token.slice(4)}` : token);

function GroupsAdmin({ groups }: { groups: AdminData["groups"] }) {
  const { pending, error, exec } = useAction();
  const [copied, setCopied] = useState<string | null>(null);

  const copyInvite = async (token: string) => {
    await navigator.clipboard.writeText(`${window.location.origin}/join/${inviteCode(token)}`);
    setCopied(token);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="panel p-4">
      <h3 className="font-semibold">Groups</h3>
      <form
        className="mt-3 flex gap-2"
        action={(form) => exec(() => createGroup(form))}
      >
        <input name="name" className="input" placeholder="Group name" required maxLength={60} />
        <input name="slug" className="input max-w-40" placeholder="url-slug (optional)" />
        <button className="btn btn-primary" disabled={pending}>
          Create
        </button>
      </form>
      <ErrorText error={error} />
      <ul className="mt-4 divide-y divide-border">
        {groups.map((g) => (
          <li key={g.id} className="py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <a href={`/g/${g.slug}`} className="font-medium hover:text-accent">
                  {g.name}
                </a>
                <span className="num ml-2 text-xs text-muted">/g/{g.slug}</span>
              </div>
              <div className="flex items-center gap-2">
                {g.token && <span className="num text-sm">/join/{inviteCode(g.token)}</span>}
                {g.token && (
                  <button className="btn" onClick={() => copyInvite(g.token!)}>
                    {copied === g.token ? "Copied!" : "Copy invite link"}
                  </button>
                )}
                <button
                  className="btn"
                  disabled={pending}
                  title="Old links stop working"
                  onClick={() => exec(() => rotateInvite(g.id))}
                >
                  Rotate
                </button>
                <button
                  className="btn btn-danger"
                  disabled={pending}
                  onClick={() =>
                    confirm(`Delete ${g.name} and all of its code?`) && exec(() => deleteGroup(g.id))
                  }
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {g.members.length === 0 && <span className="text-xs text-muted">No members yet</span>}
              {g.members.map((m) => (
                <span key={m.userId} className="badge gap-1 bg-panel-2 text-muted">
                  {m.name ?? m.email}
                  <button
                    className="hover:text-ask"
                    title="Remove from group"
                    onClick={() => exec(() => removeMember(g.id, m.userId))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NEXT_ACTIONS: Record<string, { action: LobbyAction; label: string }[]> = {
  draft: [{ action: "prepare", label: "Build dataset & publish" }],
  scheduled: [{ action: "start", label: "Start live trading" }],
  running: [
    { action: "pause", label: "Pause" },
    { action: "stop", label: "End lobby" },
  ],
  paused: [
    { action: "resume", label: "Resume" },
    { action: "stop", label: "End lobby" },
  ],
  finished: [],
};

function LobbiesAdmin({
  lobbies,
  groups,
}: {
  lobbies: AdminData["lobbies"];
  groups: AdminData["groups"];
}) {
  const { pending, error, exec } = useAction();
  const [showSeed, setShowSeed] = useState<string | null>(null);

  return (
    <div className="panel p-4">
      <h3 className="font-semibold">Live rounds</h3>
      <p className="mt-1 text-xs text-muted">Run on the engine. Pausing one doesn&apos;t affect static rounds.</p>
      <form
        className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3"
        action={(form) => exec(() => createLobby(form))}
      >
        <div className="col-span-2 md:col-span-3">
          <label className="label">Name</label>
          <input name="name" className="input" placeholder="Practice round 1" required />
        </div>
        <div>
          <label className="label">Max groups (N)</label>
          <input name="max_groups" type="number" className="input" defaultValue={20} min={1} />
        </div>
        <div>
          <label className="label">Tick (ms)</label>
          <input name="tick_ms" type="number" className="input" defaultValue={1000} min={200} />
        </div>
        <div>
          <label className="label">Dataset ticks (K)</label>
          <input name="dataset_ticks" type="number" className="input" defaultValue={10000} />
        </div>
        <div>
          <label className="label">Live ticks</label>
          <input name="live_ticks" type="number" className="input" defaultValue={3600} />
        </div>
        <div className="col-span-2">
          <label className="label">Seed (blank = random 128-bit)</label>
          <input name="seed" className="input num" placeholder="random" inputMode="numeric" />
        </div>
        <fieldset className="col-span-2 md:col-span-3">
          <legend className="label">Good (one per lobby)</legend>
          {Object.entries(GOOD_PRESETS).map(([good, description], i) => (
            <label key={good} className="flex items-start gap-2 text-sm">
              <input type="radio" name="good" value={good} defaultChecked={i === 0} className="mt-1" />
              <span>
                <span className="font-medium">{good}</span>{" "}
                <span className="text-muted">— {description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="col-span-2 md:col-span-3">
          <button className="btn btn-primary" disabled={pending}>
            Create draft lobby
          </button>
        </div>
      </form>
      <ErrorText error={error} />

      <ul className="mt-4 divide-y divide-border">
        {lobbies.map((l) => (
          <li key={l.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{l.name}</span>
                <span className={`badge ${STATUS_STYLES[l.status]}`}>{l.status}</span>
                {l.current_tick !== null && (
                  <span className="num text-xs text-muted">tick {l.current_tick}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {NEXT_ACTIONS[l.status]?.map(({ action, label }) => (
                  <button
                    key={action}
                    className={`btn ${action === "stop" ? "btn-danger" : ""}`}
                    disabled={pending}
                    onClick={() =>
                      (action !== "stop" || confirm(`End ${l.name}? This cannot be undone.`)) &&
                      exec(() => lobbyAction(l.id, action))
                    }
                  >
                    {label}
                  </button>
                ))}
                {["draft", "scheduled", "finished"].includes(l.status) && (
                  <button
                    className="btn btn-danger"
                    disabled={pending}
                    onClick={() => confirm(`Delete ${l.name}?`) && exec(() => deleteLobby(l.id))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <p className="num text-xs text-muted">
              {l.config.goods.join(", ")} · {l.config.tick_ms} ms · K={l.config.dataset_ticks} ·{" "}
              {l.config.live_ticks} live ticks · max {l.max_groups} groups ·{" "}
              <button className="underline" onClick={() => setShowSeed(showSeed === l.id ? null : l.id)}>
                {showSeed === l.id ? `seed ${l.seed}` : "show seed"}
              </button>
            </p>
            {l.entries.length > 0 && (
              <ul className="space-y-1 text-sm">
                {groups.map((g) => {
                  const entry = l.entries.find((e) => e.groupId === g.id);
                  if (!entry) return null;
                  const sub = entry.submission;
                  return (
                    <li key={g.id} className="flex min-w-0 items-center gap-3">
                      <button
                        disabled={pending || l.status === "finished"}
                        className="badge shrink-0 border border-accent text-accent"
                        title="Remove from this lobby"
                        onClick={() => exec(() => setLobbyEntry(l.id, g.id, false))}
                      >
                        ✓ {g.name}
                      </button>
                      {sub ? (
                        <span className="min-w-0 truncate">
                          <a href={`/g/${g.slug}/s/${sub.id}`} className="hover:text-accent" title="Active submission">
                            {sub.title}
                          </a>
                          <span className="text-muted"> · {languageLabel(sub.language)}</span>
                        </span>
                      ) : (
                        <span className="text-muted">no submission chosen</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {groups
                .filter((g) => !l.entries.some((e) => e.groupId === g.id))
                .map((g) => (
                  <button
                    key={g.id}
                    disabled={pending || l.status === "finished"}
                    className="badge border border-border text-muted"
                    onClick={() => exec(() => setLobbyEntry(l.id, g.id, true))}
                  >
                    + {g.name}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATIC_ACTIONS: Record<string, { action: "prepare" | StaticRoundAction; label: string }[]> = {
  draft: [{ action: "prepare", label: "Build data & publish" }],
  scheduled: [{ action: "open", label: "Open submissions" }],
  running: [
    { action: "pause", label: "Pause submissions" },
    { action: "close", label: "Close round" },
  ],
  paused: [
    { action: "resume", label: "Resume submissions" },
    { action: "close", label: "Close round" },
  ],
  finished: [],
};

function StaticRoundsAdmin({ rounds }: { rounds: AdminData["lobbies"] }) {
  const { pending, error, exec } = useAction();
  const [showSeed, setShowSeed] = useState<string | null>(null);
  const [preset, setPreset] = useState<keyof typeof STATIC_PRESETS>("BEST_TIME");

  const act = (round: AdminData["lobbies"][number], action: "prepare" | StaticRoundAction) => {
    if (action === "close" && !confirm(`Close ${round.name}? Scores become final.`)) return;
    exec(() => (action === "prepare" ? lobbyAction(round.id, action) : staticRoundAction(round.id, action)));
  };

  return (
    <div className="panel p-4">
      <h3 className="font-semibold">Static rounds</h3>
      <p className="mt-1 text-xs text-muted">
        Generated once and published. Each group&apos;s latest submission is its score. Independent of the live
        round, which you can pause meanwhile.
      </p>
      <form
        className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4"
        action={(form) => exec(() => createStaticRound(form))}
      >
        <div className="col-span-2">
          <label className="label">Name</label>
          <input name="name" className="input" placeholder="Static round 1" required />
        </div>
        <div>
          <label className="label">Ticks</label>
          <input
            name="ticks"
            type="number"
            className="input"
            placeholder={String(STATIC_PRESETS[preset].ticks)}
            min={10}
            max={20000}
          />
        </div>
        <div>
          <label className="label">Seed (blank = random)</label>
          <input name="seed" className="input num" placeholder="random" inputMode="numeric" />
        </div>
        <fieldset className="col-span-2 md:col-span-4">
          <legend className="label">Preset</legend>
          {Object.entries(STATIC_PRESETS).map(([id, p]) => (
            <label key={id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="preset"
                value={id}
                checked={preset === id}
                onChange={() => setPreset(id as keyof typeof STATIC_PRESETS)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{p.name}</span> <span className="text-muted">— {p.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="col-span-2 md:col-span-4">
          <button className="btn btn-primary" disabled={pending}>
            Create draft round
          </button>
        </div>
      </form>
      <ErrorText error={error} />

      <ul className="mt-4 divide-y divide-border">
        {rounds.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.name}</span>
                <span className={`badge ${STATUS_STYLES[r.status]}`}>{statusLabel("static", r.status)}</span>
              </div>
              <p className="num text-xs text-muted">
                {r.config.preset ? STATIC_PRESETS[r.config.preset].name : "?"} · {r.config.dataset_ticks} ticks ·{" "}
                <button className="underline" onClick={() => setShowSeed(showSeed === r.id ? null : r.id)}>
                  {showSeed === r.id ? `seed ${r.seed}` : "show seed"}
                </button>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {STATIC_ACTIONS[r.status]?.map(({ action, label }) => (
                <button
                  key={action}
                  className={`btn ${action === "close" ? "btn-danger" : ""}`}
                  disabled={pending}
                  onClick={() => act(r, action)}
                >
                  {label}
                </button>
              ))}
              <button
                className="btn btn-danger"
                disabled={pending}
                onClick={() =>
                  confirm(`Delete ${r.name}, its data, its scores and all code written for it?`) &&
                  exec(() => deleteLobby(r.id))
                }
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdminsAdmin({ data }: { data: AdminData }) {
  const { pending, error, exec } = useAction();
  return (
    <div className="panel p-4">
      <h3 className="font-semibold">People</h3>
      <div className="mt-3 grid gap-6 md:grid-cols-2">
        <ul className="divide-y divide-border text-sm">
          {data.profiles.map((p) => (
            <li key={p.id} className="flex items-center justify-between py-2">
              <span>
                {p.display_name} <span className="text-muted">{p.email}</span>
              </span>
              {p.id !== data.viewerId && (
                <button
                  className="btn"
                  disabled={pending}
                  onClick={() => exec(() => setAdmin(p.id, !p.is_admin))}
                >
                  {p.is_admin ? "Remove admin" : "Make admin"}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div>
          <p className="text-sm text-muted">
            Emails here become admins automatically the first time they sign in.
          </p>
          <form className="mt-2 flex gap-2" action={(form) => exec(() => addAllowlistEmail(form))}>
            <input name="email" type="email" className="input" placeholder="name@uchicago.edu" />
            <button className="btn" disabled={pending}>
              Add
            </button>
          </form>
          <ul className="mt-3 space-y-1 text-sm">
            {data.allowlist.map((email) => (
              <li key={email} className="flex items-center justify-between">
                <span className="num">{email}</span>
                <button
                  className="text-muted hover:text-ask"
                  onClick={() => exec(() => removeAllowlistEmail(email))}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
