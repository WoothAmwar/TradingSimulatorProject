"use client";

import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { GroupStats, GroupTrade, TradeParty } from "@/lib/feed";
import { asTime, CHART_OPTIONS, type PriceChartHandle } from "./price-chart";

/** Recent trades kept on the page, like TRADE_HISTORY in engine/server/trades.py. */
export const TRADE_HISTORY = 300;
const TAPE_ROWS = 100;
const TIP_ROWS = 6;
const VISIBLE_POINTS = 150; // the chart opens on the latest ticks
// Buys and sells use the market's bid and ask colors, and arrows pointing up or down.
const BUY = "#22c55e";
const SELL = "#ef4444";
const FADED = "rgba(139, 147, 167, 0.35)"; // other groups' trades while one group is picked

/** One group's side of a trade. */
type Leg = {
  trade: GroupTrade;
  group: { id: string; name: string };
  side: 1 | -1;
  other: TradeParty;
  took: boolean; // its order traded at once with an offer that was waiting
  edge: number | null; // per unit: better (+) or worse (−) than the market price
};

function legs(t: GroupTrade): Leg[] {
  const out: Leg[] = [];
  const edge = (side: 1 | -1) => (t.mid === null ? null : (t.mid - t.price) * side);
  if (t.buyer) out.push({ trade: t, group: t.buyer, side: 1, other: t.seller, took: t.aggressor === 1, edge: edge(1) });
  if (t.seller) out.push({ trade: t, group: t.seller, side: -1, other: t.buyer, took: t.aggressor === -1, edge: edge(-1) });
  return out;
}

const ZERO = { trades: 0, bought: 0, sold: 0, spent: 0, received: 0, edge: 0, with_groups: 0, took: 0 };

/** Adds trades to each group's totals the way engine/server/trades.py does. Returns a new object. */
export function addTrades(stats: Record<string, GroupStats>, trades: GroupTrade[]): Record<string, GroupStats> {
  const next = { ...stats };
  for (const leg of trades.flatMap(legs)) {
    const { price, qty } = leg.trade;
    const s = { ...ZERO, ...next[leg.group.id], name: leg.group.name };
    s.trades += 1;
    if (leg.side === 1) {
      s.bought += qty;
      s.spent += price * qty;
    } else {
      s.sold += qty;
      s.received += price * qty;
    }
    if (leg.edge !== null) s.edge += leg.edge * qty;
    if (leg.other) s.with_groups += 1;
    if (leg.took) s.took += 1;
    next[leg.group.id] = s;
  }
  return next;
}

const fmt = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n: number, digits: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n), digits)}`;

/** Every trade each group made: a chart of them over the price, totals per group, and a list. */
export function GroupTrades({
  ref,
  good,
  trades,
  stats,
  groups,
}: {
  /** Feeds the chart's price line, like PriceChart. */
  ref: Ref<PriceChartHandle>;
  good: string;
  trades: GroupTrade[];
  stats: Record<string, GroupStats>;
  groups: { id: string; name: string }[];
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p === id ? null : id));

  const rows = useMemo(() => {
    const names = new Map(groups.map((g) => [g.id, g.name]));
    for (const [id, s] of Object.entries(stats)) if (!names.has(id)) names.set(id, s.name);
    return [...names]
      .map(([id, name]) => ({ id, name, stats: stats[id] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, stats]);

  const tape = useMemo(
    () =>
      trades
        .flatMap(legs)
        .filter((l) => !picked || l.group.id === picked)
        .reverse()
        .slice(0, TAPE_ROWS),
    [trades, picked],
  );

  return (
    <section className="panel space-y-3 p-3">
      <div>
        <h3 className="font-semibold">Group trades</h3>
        <p className="text-xs text-muted">
          Each group&apos;s trades at the price they traded: <span style={{ color: BUY }}>▲</span> buy,{" "}
          <span style={{ color: SELL }}>▼</span> sell. Hover the chart for details, or pick a group to follow it.
        </p>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show trades for">
          <Chip active={picked === null} onClick={() => setPicked(null)}>
            All groups
          </Chip>
          {rows.map((r) => (
            <Chip key={r.id} active={picked === r.id} onClick={() => toggle(r.id)}>
              {r.name}
              <span className="num text-muted">{r.stats?.trades ?? 0}</span>
            </Chip>
          ))}
        </div>
      )}

      <TradesChart ref={ref} good={good} trades={trades} picked={picked} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Totals rows={rows} picked={picked} onPick={toggle} />
        <Tape legs={tape} />
      </div>
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`btn px-2 py-1 text-xs ${active ? "border-accent" : ""}`}
    >
      {children}
    </button>
  );
}

type Tip = { x: number; y: number; flip: boolean; tick: number; legs: Leg[] };

function TradesChart({
  ref,
  good,
  trades,
  picked,
}: {
  ref: Ref<PriceChartHandle>;
  good: string;
  trades: GroupTrade[];
  picked: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lastTick = useRef(-1);
  const latest = useRef({ trades, picked }); // read by the hover handler
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    latest.current = { trades, picked };
  }, [trades, picked]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, CHART_OPTIONS);
    const line = chart.addSeries(LineSeries, {
      color: "rgba(139, 147, 167, 0.6)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const onMove = (param: MouseEventParams<Time>) => {
      const point = param.point;
      if (!point || param.time === undefined || point.x < 0 || point.y < 0) return setTip(null);
      const tick = param.time as number;
      const { trades, picked } = latest.current;
      const here = trades
        .filter((t) => t.tick === tick && t.good === good)
        .flatMap(legs)
        .filter((l) => !picked || l.group.id === picked);
      setTip(here.length ? { x: point.x, y: point.y, flip: point.x > el.clientWidth / 2, tick, legs: here } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    chartRef.current = chart;
    seriesRef.current = line;
    markersRef.current = createSeriesMarkers(line, []);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      markersRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [good]);

  useEffect(() => {
    // Sorted by tick; at each tick the picked group's marks come last, so they're drawn on top.
    const marks = trades
      .filter((t) => t.good === good)
      .flatMap(legs)
      .map((leg, i) => ({ leg, i, top: leg.group.id === picked }))
      .sort((a, b) => a.leg.trade.tick - b.leg.trade.tick || Number(a.top) - Number(b.top) || a.i - b.i);
    markersRef.current?.setMarkers(
      marks.map(({ leg }) => ({
        time: asTime(leg.trade.tick),
        position: "atPriceMiddle",
        price: leg.trade.price,
        shape: leg.side === 1 ? "arrowUp" : "arrowDown",
        color: picked && leg.group.id !== picked ? FADED : leg.side === 1 ? BUY : SELL,
      })),
    );
  }, [trades, picked, good]);

  useImperativeHandle(ref, () => ({
    setHistory(points) {
      seriesRef.current?.setData(points.map(([t, v]) => ({ time: asTime(t), value: v })));
      lastTick.current = points.length ? points[points.length - 1][0] : -1;
      const n = points.length;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_POINTS), to: n + 2 });
    },
    push(tick, value) {
      if (tick <= lastTick.current) return;
      seriesRef.current?.update({ time: asTime(tick), value });
      lastTick.current = tick;
    },
  }));

  return (
    <div className="relative">
      <div ref={box} style={{ height: 240 }} />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-[300px] space-y-1 rounded-md border border-border bg-panel-2 px-2.5 py-2 text-xs shadow-lg"
          style={{
            left: tip.x,
            top: Math.max(0, tip.y - 16),
            transform: tip.flip ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
          }}
        >
          <div className="num text-muted">tick {tip.tick}</div>
          {tip.legs.slice(0, TIP_ROWS).map((l, i) => (
            <div key={i}>
              <div>
                <span style={{ color: l.side === 1 ? BUY : SELL }}>{l.side === 1 ? "▲" : "▼"}</span>{" "}
                <span className="font-medium">{l.group.name}</span> {l.side === 1 ? "bought" : "sold"}{" "}
                <span className="num">{l.trade.qty}</span> at <span className="num">{fmt(l.trade.price)}</span>
              </div>
              <div className="text-muted">
                {l.side === 1 ? "from" : "to"} {l.other?.name ?? "a computer trader"} ·{" "}
                {l.took ? "took an offer" : "its offer was taken"}
                {l.edge !== null && <> · {signed(l.edge, 1)} vs market</>}
              </div>
            </div>
          ))}
          {tip.legs.length > TIP_ROWS && <div className="text-muted">+{tip.legs.length - TIP_ROWS} more</div>}
        </div>
      )}
    </div>
  );
}

function Totals({
  rows,
  picked,
  onPick,
}: {
  rows: { id: string; name: string; stats?: GroupStats }[];
  picked: string | null;
  onPick: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  const th = "py-1 pr-3 text-right font-medium";
  return (
    <div className="min-w-0 space-y-1">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="py-1 pr-3 font-medium">Group</th>
              <th className={th}>Trades</th>
              <th className={th}>Bought</th>
              <th className={th}>Sold</th>
              <th className={th}>Avg buy</th>
              <th className={th}>Avg sell</th>
              <th className={th}>vs market</th>
              <th className={th}>With groups</th>
              <th className={th}>Took offers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ id, name, stats: s }) => (
              <tr key={id} className={picked === id ? "bg-panel-2" : ""}>
                <td className="py-1.5 pr-3">
                  <button type="button" className="text-left hover:text-accent" onClick={() => onPick(id)}>
                    {name}
                  </button>
                </td>
                <Num value={s?.trades ?? 0} />
                <Num value={s?.bought ?? 0} />
                <Num value={s?.sold ?? 0} />
                <Num text={s?.bought ? fmt(s.spent / s.bought, 1) : "—"} />
                <Num text={s?.sold ? fmt(s.received / s.sold, 1) : "—"} />
                <Num text={s?.trades ? signed(s.edge, 0) : "—"} />
                <Num value={s?.with_groups ?? 0} />
                <Num text={s?.trades ? `${Math.round((100 * s.took) / s.trades)}%` : "—"} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted">
        vs market: how much better (+) or worse (−) than the market price, in total. Took offers: trades that
        accepted a waiting offer instead of waiting for one.
      </p>
    </div>
  );
}

function Num({ value, text }: { value?: number; text?: string }) {
  return <td className="num py-1.5 pr-3 text-right">{text ?? fmt(value ?? 0)}</td>;
}

function Tape({ legs }: { legs: Leg[] }) {
  if (legs.length === 0) return <p className="py-6 text-center text-sm text-muted">No group has traded yet.</p>;
  const th = "py-1 pr-3 font-medium";
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className={th}>Tick</th>
            <th className={th}>Group</th>
            <th className={th}>Side</th>
            <th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Price</th>
            <th className={`${th} text-right`}>vs market</th>
            <th className={th}>With</th>
            <th className={th}>How</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {legs.map((l, i) => (
            <tr key={i}>
              <td className="num py-1 pr-3 text-muted">{l.trade.tick}</td>
              <td className="py-1 pr-3">{l.group.name}</td>
              <td className="py-1 pr-3">
                <span style={{ color: l.side === 1 ? BUY : SELL }}>{l.side === 1 ? "▲" : "▼"}</span>{" "}
                {l.side === 1 ? "Buy" : "Sell"}
              </td>
              <td className="num py-1 pr-3 text-right">{l.trade.qty}</td>
              <td className="num py-1 pr-3 text-right">{fmt(l.trade.price)}</td>
              <td className="num py-1 pr-3 text-right">{l.edge === null ? "—" : signed(l.edge, 1)}</td>
              <td className="py-1 pr-3">{l.other?.name ?? <span className="text-muted">computer</span>}</td>
              <td className="py-1 pr-3 text-muted">{l.took ? "took offer" : "offer taken"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
