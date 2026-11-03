"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { appendLines, ConsoleView, type ConsoleLine } from "@/components/code/console-view";
import { watchBot, type BotFill, type BotInfo, type BotStats, type MonitorMessage } from "@/lib/bot-monitor";
import { createClient } from "@/lib/supabase/client";
import { STATUS_STYLES } from "@/lib/lobby";
import { languageLabel } from "@/lib/templates";

export type LiveLobby = {
  id: string;
  name: string;
  status: string;
  active: { id: string; title: string; language: string } | null;
};

type View = {
  connected: boolean;
  lobbyStatus: string | null;
  tick: number | null;
  bot: BotInfo | null;
  stats: BotStats;
  pnl: number;
  position: Record<string, number>;
  fills: BotFill[];
  lines: ConsoleLine[];
  closedReason: string | null;
};

const EMPTY: View = {
  connected: false,
  lobbyStatus: null,
  tick: null,
  bot: null,
  stats: { answered: 0, missed: 0, rejects: 0, avg_ms: 0 },
  pnl: 0,
  position: {},
  fills: [],
  lines: [],
  closedReason: null,
};

function reduce(v: View, msg: MonitorMessage): View {
  switch (msg.type) {
    case "snapshot":
      return {
        ...v,
        lobbyStatus: msg.status,
        tick: msg.tick,
        bot: msg.bot,
        stats: msg.stats,
        pnl: msg.pnl,
        position: msg.position,
        fills: msg.fills,
        lines: msg.console.slice(-800),
      };
    case "bot":
      return { ...v, bot: msg.bot };
    case "result":
      return {
        ...v,
        tick: msg.tick,
        stats: msg.stats,
        pnl: msg.pnl,
        position: msg.position,
        fills: [...msg.fills.map((f) => ({ ...f, tick: msg.tick })).reverse(), ...v.fills].slice(0, 40),
      };
    case "console":
      return { ...v, lines: [...v.lines, ...msg.lines].slice(-800) };
    case "status":
      return { ...v, lobbyStatus: msg.status, tick: msg.tick ?? v.tick };
  }
}

/** What the group's bot is doing, in a few words. */
function describe(bot: BotInfo | null, lobbyStatus: string | null): string {
  if (lobbyStatus === "scheduled") return "Your bot starts when the round starts.";
  if (lobbyStatus === "finished") return "The round has finished.";
  switch (bot?.status) {
    case "none":
      return "No active submission: pick one on the overview.";
    case "starting":
      return "Starting your bot…";
    case "running":
      return lobbyStatus === "paused" ? "Running; the round is paused." : "Running.";
    case "stopped":
      return bot.message ?? "Stopped.";
    default:
      return "Connecting to the exchange…";
  }
}

export function LivePanel({
  slug,
  engineUrl,
  groupId,
  lobbies,
}: {
  slug: string;
  engineUrl: string;
  groupId: string;
  lobbies: LiveLobby[];
}) {
  const [selected, setSelected] = useState(lobbies.find((l) => l.active)?.id ?? lobbies[0]?.id ?? "");
  const [view, setView] = useState<View>(EMPTY);
  const lobby = lobbies.find((l) => l.id === selected);

  useEffect(() => {
    if (!selected) return;
    const monitor = watchBot({
      engineUrl,
      lobbyId: selected,
      groupId,
      getToken: async () => (await createClient().auth.getSession()).data.session?.access_token ?? null,
      onMessage: (msg) => setView((v) => reduce(v, msg)),
      onState: (connected) => setView((v) => ({ ...v, connected })),
      onClosed: (reason) =>
        setView((v) => ({ ...v, closedReason: reason, lines: appendLines(v.lines, [reason], "error") })),
    });
    return () => monitor.close();
  }, [engineUrl, groupId, selected]);

  if (lobbies.length === 0) {
    return (
      <div className="panel p-6 text-sm text-muted">
        Your group isn&apos;t entered in an open lobby. An admin enters groups into lobbies.
      </div>
    );
  }

  const status = view.lobbyStatus ?? lobby?.status ?? "";
  const bot = view.bot;
  const running = bot?.status === "running";
  const submission = bot?.submission ?? lobby?.active ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
      <div className="space-y-4">
        <section className="panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input max-w-72"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setView(EMPTY);
              }}
            >
              {lobbies.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.status})
                </option>
              ))}
            </select>
            {status && <span className={`badge ${STATUS_STYLES[status]}`}>{status}</span>}
          </div>
          {submission ? (
            <p className="text-sm text-muted">
              Active submission:{" "}
              <Link href={`/g/${slug}/s/${submission.id}`} className="text-foreground hover:text-accent">
                {submission.title}
              </Link>{" "}
              ({languageLabel(submission.language)}). Change it on the{" "}
              <Link href={`/g/${slug}`} className="underline">overview</Link>.
            </p>
          ) : (
            <p className="text-sm text-accent">Pick an active submission for this lobby on the overview.</p>
          )}
          <p className={`text-sm ${bot?.status === "stopped" || view.closedReason ? "text-ask" : ""}`}>
            {view.closedReason ?? describe(bot, status)}
          </p>
          <p className="text-xs text-muted">
            The exchange runs your active submission for the whole group while the round is live. No tab has to
            stay open; this page only shows what the bot is doing.
          </p>
        </section>

        <section className="panel grid grid-cols-2 gap-4 p-4 text-sm md:grid-cols-4">
          <Metric
            label="Bot"
            value={bot && status !== "scheduled" ? bot.status : "—"}
            tone={running ? "text-bid" : bot?.status === "stopped" ? "text-ask" : ""}
          />
          <Metric label="Tick" value={view.tick?.toString() ?? "—"} />
          <Metric
            label="PnL (mid)"
            value={Math.round(view.pnl).toLocaleString()}
            tone={view.pnl >= 0 ? "text-bid" : "text-ask"}
          />
          <Metric
            label="Position"
            value={Object.entries(view.position).map(([g, q]) => `${g}: ${q}`).join("  ") || "—"}
          />
          <Metric label="Ticks answered" value={view.stats.answered.toString()} />
          <Metric
            label="Ticks missed"
            value={view.stats.missed.toString()}
            tone={view.stats.missed ? "text-accent" : ""}
          />
          <Metric
            label="Rejected orders"
            value={view.stats.rejects.toString()}
            tone={view.stats.rejects ? "text-accent" : ""}
          />
          <Metric label="Avg bot time" value={`${Math.round(view.stats.avg_ms)} ms`} />
        </section>

        <section className="panel p-4">
          <h3 className="mb-2 text-sm font-semibold">Recent fills</h3>
          {view.fills.length === 0 && <p className="text-sm text-muted">No fills yet.</p>}
          <table className="num w-full text-xs">
            <tbody>
              {view.fills.map((f, i) => (
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
        <h3 className="text-sm font-semibold">
          Console <span className="font-normal text-muted">(from the exchange)</span>
        </h3>
        <ConsoleView lines={view.lines} height="calc(100vh - 14rem)" />
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
