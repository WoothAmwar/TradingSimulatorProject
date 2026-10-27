"use client";

import { useEffect, useRef, useState } from "react";
import { connectFeed, wsUrl, type Book, type FeedMessage, type LeaderRow, type Trade } from "@/lib/feed";
import { OrderBook } from "./order-book";
import { PriceChart, type PriceChartHandle } from "./price-chart";

type TapeEntry = { tick: number; price: number; qty: number; side: 1 | -1 };

export function LiveMarket({
  lobbyId,
  engineUrl,
  goods,
}: {
  lobbyId: string;
  engineUrl: string;
  goods: string[];
}) {
  const charts = useRef<Record<string, PriceChartHandle | null>>({});
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [tick, setTick] = useState<number | null>(null);
  const [books, setBooks] = useState<Record<string, Book>>({});
  const [mids, setMids] = useState<Record<string, number | null>>({});
  const [tape, setTape] = useState<Record<string, TapeEntry[]>>({});
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);

  useEffect(() => {
    const handle = (msg: FeedMessage) => {
      if (msg.type === "snapshot") {
        setStatus(msg.status);
        setTick(msg.tick);
        setBooks(msg.books);
        setLeaders(msg.leaderboard);
        for (const [good, points] of Object.entries(msg.history)) {
          charts.current[good]?.setHistory(points);
          const last = points[points.length - 1];
          if (last) setMids((m) => ({ ...m, [good]: last[1] }));
        }
      } else if (msg.type === "tick") {
        setTick(msg.tick);
        setBooks(msg.books);
        setMids(msg.mids);
        for (const [good, mid] of Object.entries(msg.mids)) {
          if (mid !== null) charts.current[good]?.push(msg.tick, mid);
        }
        setTape((prev) => {
          const next = { ...prev };
          for (const [good, trades] of Object.entries(msg.trades)) {
            if (!trades.length) continue;
            const fresh = trades.map(([price, qty, side]: Trade) => ({ tick: msg.tick, price, qty, side }));
            next[good] = [...fresh.reverse(), ...(prev[good] ?? [])].slice(0, 25);
          }
          return next;
        });
        if (msg.leaderboard) setLeaders(msg.leaderboard);
      } else if (msg.type === "status") {
        setStatus(msg.status);
        setTick(msg.tick);
      }
    };
    const feed = connectFeed(wsUrl(engineUrl, `/ws/market/${lobbyId}`), handle, setConnected);
    return () => feed.close();
  }, [engineUrl, lobbyId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-bid" : "bg-ask"}`} />
        <span className="text-muted">{connected ? "Live" : "Connecting to engine…"}</span>
        {status && <span className="text-muted">· {status}</span>}
        {tick !== null && <span className="num text-muted">· tick {tick}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
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
                <div className="max-h-[260px] overflow-hidden">
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
          <h3 className="mb-2 font-semibold">Leaderboard</h3>
          {leaders.length === 0 && <p className="text-sm text-muted">No trading yet.</p>}
          <ol className="space-y-1">
            {leaders.map((row, i) => (
              <li key={row.group_id} className="flex items-center justify-between text-sm">
                <span>
                  <span className="num mr-2 text-muted">{i + 1}</span>
                  {row.name}
                </span>
                <span className={`num ${row.pnl >= 0 ? "text-bid" : "text-ask"}`}>
                  {Math.round(row.pnl).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
