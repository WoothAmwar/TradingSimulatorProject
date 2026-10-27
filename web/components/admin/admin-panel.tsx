"use client";

import { useState, useTransition } from "react";
import {
  addAllowlistEmail,
  createGroup,
  createLobby,
  deleteGroup,
  deleteLobby,
  lobbyAction,
  removeAllowlistEmail,
  removeMember,
  rotateInvite,
  setAdmin,
  setLobbyEntry,
  type ActionResult,
} from "@/app/actions/admin";
import type { LobbyAction } from "@/lib/engine";
import { GOOD_PRESETS, STATUS_STYLES, type PublicConfig } from "@/lib/lobby";

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
    max_groups: number;
    current_tick: number | null;
    config: PublicConfig;
    seed: string | null;
    groupIds: string[];
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

export function AdminPanel({ data }: { data: AdminData }) {
  return (
    <section className="space-y-6">
      <h2 className="text-lg font-semibold">
        Admin <span className="badge ml-2 bg-accent/15 text-accent">only visible to admins</span>
      </h2>
      <div className="grid gap-6 xl:grid-cols-2">
        <GroupsAdmin groups={data.groups} />
        <LobbiesAdmin lobbies={data.lobbies} groups={data.groups} />
      </div>
      <AdminsAdmin data={data} />
    </section>
  );
}

function GroupsAdmin({ groups }: { groups: AdminData["groups"] }) {
  const { pending, error, exec } = useAction();
  const [copied, setCopied] = useState<string | null>(null);

  const copyInvite = async (token: string) => {
    await navigator.clipboard.writeText(`${window.location.origin}/join/${token}`);
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
              <div className="flex gap-2">
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
      <h3 className="font-semibold">Lobbies</h3>
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
          <legend className="label">Goods</legend>
          {Object.entries(GOOD_PRESETS).map(([good, description]) => (
            <label key={good} className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="goods" value={good} defaultChecked className="mt-1" />
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
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const entered = l.groupIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    disabled={pending || l.status === "finished"}
                    className={`badge border ${entered ? "border-accent text-accent" : "border-border text-muted"}`}
                    onClick={() => exec(() => setLobbyEntry(l.id, g.id, !entered))}
                  >
                    {entered ? "✓ " : "+ "}
                    {g.name}
                  </button>
                );
              })}
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
