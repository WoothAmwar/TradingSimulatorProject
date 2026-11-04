"use client";

import { useEffect, useRef, useState } from "react";
import {
  connectFeed,
  wsUrl,
  type Book,
  type FeedMessage,
  type GroupStats,
  type GroupTrade,
  type LeaderRow,
  type Trade,
} from "@/lib/feed";
import {
  addScores,
  HISTORY_TICKS,
  mergeSaved,
  RATE_TICKS,
  RECENT_TICKS,
  tickSeconds,
  trend,
  type ScoreHistory,
} from "@/lib/score-trend";
import { createClient } from "@/lib/supabase/client";
import { addTrades, GroupTrades, TRADE_HISTORY } from "./group-trades";
import { OrderBook } from "./order-book";
import { PriceChart, type PriceChartHandle } from "./price-chart";
import { Scoreboard, type ScoreboardData } from "./scoreboard";

type TapeEntry = { tick: number; price: number; qty: number; side: 1 | -1 };

const LIVE = new Set(["running", "paused"]);

export function LiveMarket({
  lobbyId,
  lobbyName,
  engineUrl,
  goods,
  startTick,
  tickMs,
  scoreboard,
}: {
  lobbyId: string;
  lobbyName: string;
  engineUrl: string;
  goods: string[];
  /** The first live tick (ticks before it are the public dataset). */
  startTick: number;
  tickMs: number;
  /** Static rounds to show next to this lobby's live scores. */
  scoreboard: ScoreboardData;
}) {
  const charts = useRef<Record<string, PriceChartHandle | null>>({});
  const tradeChart = useRef<PriceChartHandle | null>(null);
  const tradeGood = goods[0]; // each lobby trades one good
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [tick, setTick] = useState<number | null>(null);
  const [books, setBooks] = useState<Record<string, Book>>({});
  const [mids, setMids] = useState<Record<string, number | null>>({});
  const [tape, setTape] = useState<Record<string, TapeEntry[]>>({});
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);
  const [groupTrades, setGroupTrades] = useState<GroupTrade[]>([]);
  const [groupStats, setGroupStats] = useState<Record<string, GroupStats>>({});
  const [scores, setScores] = useState<ScoreHistory>({});

  useEffect(() => {
    let closed = false;
    // Scores from before this page opened (or while it was disconnected).
    const loadSaved = () => {
      createClient()
        .rpc("lobby_score_history", { p_lobby: lobbyId, p_ticks: HISTORY_TICKS })
        .then(({ data }) => {
          if (!closed && data) setScores((h) => mergeSaved(h, data));
        });
    };
    const handle = (msg: FeedMessage) => {
      if (msg.type === "snapshot") {
        setStatus(msg.status);
        setTick(msg.tick);
        setBooks(msg.books);
        setLeaders(msg.leaderboard);
        const at = msg.tick;
        if (at !== null && LIVE.has(msg.status)) {
          setScores((h) => addScores(h, at, msg.leaderboard));
          loadSaved();
        }
        setGroupTrades(msg.group_trades ?? []);
        setGroupStats(msg.group_stats ?? {});
        for (const [good, points] of Object.entries(msg.history)) {
          charts.current[good]?.setHistory(points);
          const last = points[points.length - 1];
          if (last) setMids((m) => ({ ...m, [good]: last[1] }));
        }
        tradeChart.current?.setHistory(msg.history[tradeGood] ?? []);
      } else if (msg.type === "tick") {
        setTick(msg.tick);
        setBooks(msg.books);
        setMids(msg.mids);
        for (const [good, mid] of Object.entries(msg.mids)) {
          if (mid !== null) charts.current[good]?.push(msg.tick, mid);
        }
        const mid = msg.mids[tradeGood];
        if (mid != null) tradeChart.current?.push(msg.tick, mid);
        setTape((prev) => {
          const next = { ...prev };
          for (const [good, trades] of Object.entries(msg.trades)) {
            if (!trades.length) continue;
            const fresh = trades.map(([price, qty, side]: Trade) => ({ tick: msg.tick, price, qty, side }));
            next[good] = [...fresh.reverse(), ...(prev[good] ?? [])].slice(0, 25);
          }
          return next;
        });
        const board = msg.leaderboard;
        if (board) {
          setLeaders(board);
          setScores((h) => addScores(h, msg.tick, board));
        }
      } else if (msg.type === "status") {
        setStatus(msg.status);
        setTick(msg.tick);
      } else if (msg.type === "trades") {
        setGroupTrades((prev) => [...prev, ...msg.trades].slice(-TRADE_HISTORY));
        setGroupStats((prev) => addTrades(prev, msg.trades));
      }
    };
    const feed = connectFeed(wsUrl(engineUrl, `/ws/market/${lobbyId}`), handle, setConnected);
    return () => {
      closed = true;
      feed.close();
    };
  }, [engineUrl, lobbyId, tradeGood]);

  // Final scores value held units at fair value, so the recent columns only make sense live.
  const live = status !== null && LIVE.has(status);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-bid" : "bg-ask"}`} />
        <span className="text-muted">{connected ? "Live" : "Connecting to engine…"}</span>
        {status && <span className="text-muted">· {status}</span>}
        {tick !== null && <span className="num text-muted">· tick {tick}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {goods.map((good) => (
            <div key={good} className="panel p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="font-semibold">{good}</h3>
                <span className="num text-lg">{mids[good]?.toFixed(1) ?? "—"}</span>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_200px_170px]">
                <PriceChart ref={(h) => { charts.current[good] = h; }} />
                <OrderBook book={books[good]} />
                <div className="h-[260px] overflow-hidden">
                  <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">Trades</div>
                  {(tape[good] ?? []).map((t, i) => (
                    <div key={i} className="num flex justify-between px-1 text-xs">
                      <span className={t.side > 0 ? "text-bid" : "text-ask"}>{t.price}</span>
                      <span className="text-muted">{t.qty}</span>
                      <span className="text-muted/60">{t.tick}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="panel h-fit p-3">
          <h3 className="font-semibold">Leaderboard</h3>
          <p className="mb-2 text-xs text-muted">
            Units still held count at the current price.
            {live && " The last two columns show who is earning faster now."}
          </p>
          {leaders.length === 0 && <p className="text-sm text-muted">No trading yet.</p>}
          {leaders.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="align-bottom text-[10px] uppercase tracking-wide text-muted">
                  <th className="pb-1 text-left font-normal">Group</th>
                  <th className="pb-1 pl-2 text-right font-normal">Score</th>
                  {live && (
                    <th className="pb-1 pl-2 text-right font-normal">
                      Last {RECENT_TICKS} ticks{" "}
                      <span className="normal-case">({tickSeconds(RECENT_TICKS, tickMs)})</span>
                    </th>
                  )}
                  {live && (
                    <th className="pb-1 pl-2 text-right font-normal">
                      Per tick, last {RATE_TICKS.toLocaleString()}{" "}
                      <span className="normal-case">({tickSeconds(RATE_TICKS, tickMs)})</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {leaders.map((row, i) => {
                  const change = live ? trend(scores[row.group_id], startTick) : null;
                  return (
                    <tr key={row.group_id}>
                      <td className="whitespace-nowrap py-0.5">
                        <span className="num mr-2 text-muted">{i + 1}</span>
                        <span className="inline-block max-w-32 truncate align-bottom">{row.name}</span>
                        {row.online === false && <span className="ml-1.5 text-xs text-muted">bot off</span>}
                      </td>
                      <td className={`num pl-2 text-right ${row.pnl >= 0 ? "text-bid" : "text-ask"}`}>
                        {Math.round(row.pnl).toLocaleString()}
                      </td>
                      {change && <Change value={change.recent} digits={0} />}
                      {change && <Change value={change.perTick} digits={2} />}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {tradeGood && (
        <GroupTrades
          ref={tradeChart}
          good={tradeGood}
          trades={groupTrades}
          stats={groupStats}
          groups={leaders.map((r) => ({ id: r.group_id, name: r.name }))}
        />
      )}

      <Scoreboard {...scoreboard} live={{ name: lobbyName, status, leaders }} />
    </div>
  );
}

/** A signed change: green up, red down, "—" until enough ticks are known. */
function Change({ value, digits }: { value: number | null; digits: number }) {
  if (value === null) return <td className="num pl-2 text-right text-muted">—</td>;
  const shown = Number(value.toFixed(digits));
  const text = Math.abs(shown).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const [sign, tone] = shown > 0 ? ["+", "text-bid"] : shown < 0 ? ["-", "text-ask"] : ["", "text-muted"];
  return (
    <td className={`num pl-2 text-right ${tone}`}>
      {sign}
      {text}
    </td>
  );
}
