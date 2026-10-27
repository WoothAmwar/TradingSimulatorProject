"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { appendLines, ConsoleView, type ConsoleLine } from "@/components/code/console-view";
import { startBot } from "@/lib/runtime/bots";
import { LiveSession, type LiveEvent } from "@/lib/runtime/live";
import type { RuntimeWorker } from "@/lib/runtime/sandbox";
import { createClient } from "@/lib/supabase/client";
import { STATUS_STYLES } from "@/lib/lobby";
import { languageLabel, type Language } from "@/lib/templates";

export type LiveLobby = {
  id: string;
  name: string;
  status: string;
  active: { id: string; title: string; language: Language; source: string } | null;
};

type Stats = {
  connected: boolean;
  tick: number | null;
  pnl: number;
  position: Record<string, number>;
  answered: number;
  missed: number;
  rejects: number;
  avgMs: number;
  fills: { tick: number; good: string; price: number; qty: number }[];
};

const EMPTY: Stats = {
  connected: false,
  tick: null,
  pnl: 0,
  position: {},
  answered: 0,
  missed: 0,
  rejects: 0,
  avgMs: 0,
  fills: [],
};

export function LivePanel({
  slug,
  engineUrl,
  lobbies,
  canTrade,
}: {
  slug: string;
  engineUrl: string;
  lobbies: LiveLobby[];
  canTrade: boolean;
}) {
  const [selected, setSelected] = useState(lobbies.find((l) => l.active)?.id ?? lobbies[0]?.id ?? "");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const session = useRef<LiveSession | null>(null);
  const worker = useRef<RuntimeWorker | null>(null);
  const lobby = lobbies.find((l) => l.id === selected);

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  useEffect(
    () => () => {
      session.current?.stop();
      worker.current?.terminate();
    },
    [],
  );

  const log = (text: string[], kind: ConsoleLine["kind"] = "log") =>
    setLines((prev) => appendLines(prev, text, kind));

  const onEvent = (e: LiveEvent) => {
    switch (e.type) {
      case "connected":
      case "disconnected":
        setStats((s) => ({ ...s, connected: e.type === "connected" }));
        if (e.type === "connected") log(["Connected to the exchange."], "info");
        break;
      case "welcome":
        log([`Trading as your group. Lobby is ${e.status}; tick ${e.tick ?? "—"} of ${e.endTick}.`], "info");
        break;
      case "tick":
        setStats((s) => ({
          ...s,
          tick: e.tick,
          answered: s.answered + 1,
          avgMs: s.answered ? s.avgMs + (e.ms - s.avgMs) / (s.answered + 1) : e.ms,
        }));
        break;
      case "missed":
        setStats((s) => ({ ...s, missed: s.missed + 1 }));
        log([`tick ${e.tick}: skipped — ${e.reason}`], "error");
        break;
      case "result":
        setStats((s) => ({
          ...s,
          pnl: e.pnl,
          position: e.position,
          rejects: s.rejects + e.rejects.length,
          fills: [...e.fills.map((f) => ({ ...f, tick: e.tick })).reverse(), ...s.fills].slice(0, 40),
        }));
        if (e.rejects.length) log(e.rejects.map((r) => `tick ${e.tick}: rejected — ${r}`), "error");
        break;
      case "logs":
        log(e.lines);
        break;
      case "error":
        log([e.message], "error");
        break;
      case "closed":
        setClosedReason(e.reason);
        log([`Stopped: ${e.reason}`], "error");
        stop();
        break;
    }
  };

  const start = async () => {
    if (!lobby?.active) return;
    const { language, source } = lobby.active;
    setRunning(true);
    setClosedReason(null);
    setStats(EMPTY);
    setLines([]);
    try {
      const started = await startBot(language, source, setStatus);
      worker.current = started.worker;
      log(started.logs);
      setStatus(null);
      const s = new LiveSession({
        engineUrl,
        lobbyId: lobby.id,
        worker: started.worker,
        getToken: async () => (await createClient().auth.getSession()).data.session?.access_token ?? null,
        restart: async () => {
          const again = await startBot(language, source, setStatus);
          worker.current = again.worker;
          return again.worker;
        },
        onEvent,
      });
      session.current = s;
      s.start();
    } catch (e) {
      const err = e as Error & { logs?: string[] };
      if (err.logs) log(err.logs);
      log([err.message], "error");
      setRunning(false);
      setStatus(null);
    }
  };

  function stop() {
    session.current?.stop();
    session.current = null;
    worker.current?.terminate();
    worker.current = null;
    setRunning(false);
    setStatus(null);
  }

  if (lobbies.length === 0) {
    return (
      <div className="panel p-6 text-sm text-muted">
        Your group isn&apos;t entered in an open lobby. An admin enters groups into lobbies.
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
      <div className="space-y-4">
        <section className="panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input max-w-72"
              value={selected}
              disabled={running}
              onChange={(e) => setSelected(e.target.value)}
            >
              {lobbies.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.status})
                </option>
              ))}
            </select>
            {lobby && <span className={`badge ${STATUS_STYLES[lobby.status]}`}>{lobby.status}</span>}
            <div className="ml-auto flex gap-2">
              {!running ? (
                <button className="btn btn-primary" onClick={start} disabled={!canTrade || !lobby?.active}>
                  Start bot in this tab
                </button>
              ) : (
                <button className="btn btn-danger" onClick={stop}>
                  Stop bot
                </button>
              )}
            </div>
          </div>
          {lobby?.active ? (
            <p className="text-sm text-muted">
              Active submission:{" "}
              <Link href={`/g/${slug}/s/${lobby.active.id}`} className="text-foreground hover:text-accent">
                {lobby.active.title}
              </Link>{" "}
              ({languageLabel(lobby.active.language)}). Change it on the{" "}
              <Link href={`/g/${slug}`} className="underline">overview</Link>.
            </p>
          ) : (
            <p className="text-sm text-accent">Pick an active submission for this lobby on the overview first.</p>
          )}
          {!canTrade && <p className="text-sm text-accent">Only group members can trade.</p>}
          {status && <p className="text-xs text-muted">{status}</p>}
          {closedReason && <p className="text-sm text-ask">{closedReason}</p>}
          <p className="text-xs text-muted">
            Your bot runs in this browser tab and trades for the whole group. Keep the tab open and visible;
            closing it cancels your resting orders. If a teammate starts the bot elsewhere, this session stops.
          </p>
        </section>

        <section className="panel grid grid-cols-2 gap-4 p-4 text-sm md:grid-cols-4">
          <Metric label="Connection" value={running ? (stats.connected ? "live" : "connecting…") : "stopped"} />
          <Metric label="Tick" value={stats.tick?.toString() ?? "—"} />
          <Metric
            label="PnL (mid)"
            value={Math.round(stats.pnl).toLocaleString()}
            tone={stats.pnl >= 0 ? "text-bid" : "text-ask"}
          />
          <Metric
            label="Position"
            value={Object.entries(stats.position).map(([g, q]) => `${g}: ${q}`).join("  ") || "—"}
          />
          <Metric label="Ticks answered" value={stats.answered.toString()} />
          <Metric label="Ticks missed" value={stats.missed.toString()} tone={stats.missed ? "text-accent" : ""} />
          <Metric label="Rejected orders" value={stats.rejects.toString()} tone={stats.rejects ? "text-accent" : ""} />
          <Metric label="Avg bot time" value={`${Math.round(stats.avgMs)} ms`} />
        </section>

        <section className="panel p-4">
          <h3 className="mb-2 text-sm font-semibold">Recent fills</h3>
          {stats.fills.length === 0 && <p className="text-sm text-muted">No fills yet.</p>}
          <table className="num w-full text-xs">
            <tbody>
              {stats.fills.map((f, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 text-muted">{f.tick}</td>
                  <td>{f.good}</td>
                  <td className={f.qty > 0 ? "text-bid" : "text-ask"}>{f.qty > 0 ? `+${f.qty}` : f.qty}</td>
                  <td className="text-right">@ {f.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Console</h3>
        <ConsoleView lines={lines} height="calc(100vh - 14rem)" />
      </section>
    </div>
  );
}

function Metric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num ${tone}`}>{value}</div>
    </div>
  );
}
