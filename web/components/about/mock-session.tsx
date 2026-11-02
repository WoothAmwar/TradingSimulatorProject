"use client";

import { useState } from "react";
import { Ladder, type LadderRow } from "./ladder";

type Level = [price: number, qty: number];
type Arrival = { who: string; side: 1 | -1; qty: number };
type Script = { bids: Level[]; asks: Level[]; arrivals: Arrival[]; note: string };

const LIMIT = 10;

// A scripted market. The bot's orders and every number below are computed from it.
const SCRIPT: Script[] = [
  {
    bids: [[99, 10], [98, 14]],
    asks: [[103, 9], [104, 12]],
    arrivals: [{ who: "A trader", side: -1, qty: 3 }],
    note: "The best offers are 99 and 103, so the bot offers 100 and 102 and is first in line. A trader sells it 3.",
  },
  {
    bids: [[99, 10], [98, 14]],
    asks: [[103, 9], [104, 12]],
    arrivals: [{ who: "A trader", side: 1, qty: 4 }],
    note: "A trader buys 4 from the bot at 102. It bought at 100 and sold at 102: 2 profit a unit.",
  },
  {
    bids: [[100, 8], [99, 6]],
    asks: [[103, 11], [104, 5]],
    arrivals: [],
    note: "The offers moved and the bot's offers follow them. Nobody trades with it this tick.",
  },
  {
    bids: [[99, 9]],
    asks: [[101, 7]],
    arrivals: [],
    note: "The gap is only 2, so there's no room for better offers. The bot returns []: no orders this tick.",
  },
  {
    bids: [[100, 12]],
    asks: [[104, 6]],
    arrivals: [{ who: "A well-informed trader", side: -1, qty: 5 }],
    note: "A trader who knows where the price is heading sells the bot 5 at 101…",
  },
  {
    bids: [[96, 10]],
    asks: [[100, 8]],
    arrivals: [{ who: "A trader", side: 1, qty: 2 }],
    note: "…and the price drops to about 98. Trading with someone who knows more is the main risk.",
  },
];

/** The Python template's logic: one tick inside the spread, sized by room under the limit. */
function starterOrders(bids: Level[], asks: Level[], position: number) {
  if (!bids.length || !asks.length) return [];
  const [bestBid, bestAsk] = [bids[0][0], asks[0][0]];
  if (bestAsk - bestBid <= 2) return [];
  const orders: { price: number; qty: number }[] = [];
  const buy = Math.min(5, LIMIT - position);
  const sell = Math.min(5, LIMIT + position);
  if (buy > 0) orders.push({ price: bestBid + 1, qty: buy });
  if (sell > 0) orders.push({ price: bestAsk - 1, qty: -sell });
  return orders;
}

const STEPS = (() => {
  let position = 0;
  let cash = 0;
  return SCRIPT.map((step, tick) => {
    const before = { position, cash };
    const orders = starterOrders(step.bids, step.asks, position);
    const fills = step.arrivals.flatMap((a) => {
      // A buyer takes your ask, a seller takes your bid: you have the best price on that side.
      const quote = orders.find((o) => Math.sign(o.qty) === -a.side);
      if (!quote) return [];
      const qty = Math.min(a.qty, Math.abs(quote.qty)) * -a.side;
      position += qty;
      cash -= qty * quote.price;
      return [{ who: a.who, price: quote.price, qty }];
    });
    const mid = (step.bids[0][0] + step.asks[0][0]) / 2;
    return { tick, ...step, before, orders, fills, position, cash, mid, pnl: cash + position * mid };
  });
})();

export function MockSession() {
  const [i, setI] = useState(0);
  const s = STEPS[i];
  const rows: LadderRow[] = [];
  const prices = [...s.bids, ...s.asks].map(([p]) => p).concat(s.orders.map((o) => o.price));
  for (let price = Math.max(...prices); price >= Math.min(...prices); price--) {
    const mine = s.orders.find((o) => o.price === price);
    rows.push({
      price,
      bid: mine && mine.qty > 0 ? mine.qty : s.bids.find(([p]) => p === price)?.[1],
      ask: mine && mine.qty < 0 ? -mine.qty : s.asks.find(([p]) => p === price)?.[1],
      mine: mine ? (mine.qty > 0 ? "bid" : "ask") : undefined,
    });
  }
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5" aria-label="Ticks">
          {STEPS.map((step) => (
            <button
              key={step.tick}
              onClick={() => setI(step.tick)}
              className={`num h-7 w-7 rounded text-xs ${step.tick === i ? "bg-accent text-black" : "bg-panel-2 text-muted hover:text-foreground"}`}
              aria-label={`Tick ${step.tick}`}
            >
              {step.tick}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setI(i - 1)} disabled={i === 0}>
            ← Previous tick
          </button>
          <button className="btn btn-primary" onClick={() => setI(i + 1)} disabled={i === STEPS.length - 1}>
            Next tick →
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_14rem]">
        <div>
          <h4 className="mb-1 text-xs font-semibold text-muted">Offers, including the bot&apos;s</h4>
          <Ladder rows={rows} maxQty={14} />
        </div>

        <div className="min-w-0 space-y-3">
          <div>
            <h4 className="mb-1 text-xs font-semibold text-muted">What run(state) sees</h4>
            <pre className="num overflow-x-auto rounded-md border border-border bg-background p-2 text-xs leading-relaxed">
              {[
                `state.tick = ${s.tick}`,
                `state.price = ${fmt(s.mid)}`,
                `state.bids = [${s.bids.map(([p, q]) => `(${p}, ${q})`).join(", ")}]`,
                `state.asks = [${s.asks.map(([p, q]) => `(${p}, ${q})`).join(", ")}]`,
                `state.position = ${s.before.position}`,
                `state.limit = ${LIMIT}`,
                `state.cash = ${s.before.cash}`,
              ].join("\n")}
            </pre>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-muted">What it returns</h4>
            <pre className="num overflow-x-auto rounded-md border border-border bg-background p-2 text-xs text-accent">
              {s.orders.length
                ? `[${s.orders.map((o) => `${o.qty > 0 ? "buy" : "sell"}(${o.price}, ${Math.abs(o.qty)})`).join(", ")}]`
                : "[]"}
            </pre>
          </div>
          <p className="text-sm">{s.note}</p>
        </div>

        <div className="space-y-2 text-sm">
          <h4 className="text-xs font-semibold text-muted">After the tick</h4>
          {s.fills.length === 0 && <p className="text-muted">No trades.</p>}
          {s.fills.map((f, k) => (
            <p key={k}>
              {f.who} {f.qty > 0 ? "sells" : "buys"} {Math.abs(f.qty)}: you{" "}
              <span className={f.qty > 0 ? "text-bid" : "text-ask"}>
                {f.qty > 0 ? "buy" : "sell"} {Math.abs(f.qty)} @ {f.price}
              </span>
            </p>
          ))}
          <dl className="num grid grid-cols-2 gap-x-2 gap-y-1 border-t border-border pt-2 text-xs">
            <dt className="text-muted">units owned</dt>
            <dd className="text-right">{s.position}</dd>
            <dt className="text-muted">cash</dt>
            <dd className="text-right">{s.cash}</dd>
            <dt className="text-muted">price</dt>
            <dd className="text-right">{fmt(s.mid)}</dd>
            <dt className="text-muted">score so far</dt>
            <dd className={`text-right ${s.pnl >= 0 ? "text-bid" : "text-ask"}`}>{fmt(s.pnl)}</dd>
          </dl>
          <p className="text-[11px] text-muted">score = cash + units owned × price</p>
        </div>
      </div>
    </div>
  );
}
