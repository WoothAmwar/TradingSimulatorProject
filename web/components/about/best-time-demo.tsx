"use client";

import { useMemo, useState } from "react";
import { MiniChart, type ChartMarker } from "./mini-chart";
import { mulberry32, normal } from "./random";

const N = 14;

// run() from the best-time template; the demo highlights the lines that ran on each tick.
const RUN = `def run(self, state):
    if state.position == 0 and not self.sold:
        return [buy(state.price, 1)]
    if state.position == 1 and self.is_highest_from_now(state.prices, state.tick):
        self.sold = True
        return [sell(state.price, 1)]
    return []`.split("\n");
const LINES = { buy: [1, 2], sell: [3, 4, 5], nothing: [6] } as const;

function makePrices(seed: number) {
  const rand = mulberry32(seed);
  let p = 30;
  return Array.from({ length: N }, () => (p = Math.max(5, Math.round(p + 4 * normal(rand)))));
}

/** One run() call per tick, following the template: buy at once, sell when no higher price is coming. */
function simulate(prices: number[]) {
  let position = 0;
  let sold = false;
  let cash = 0;
  return prices.map((price, tick) => {
    let action: keyof typeof LINES = "nothing";
    if (position === 0 && !sold) {
      action = "buy";
      position = 1;
      cash -= price;
    } else if (position === 1 && price >= Math.max(...prices.slice(tick))) {
      action = "sell";
      sold = true;
      position = 0;
      cash += price;
    }
    return { tick, price, action, score: cash + position * price };
  });
}

/** The best possible score: own the unit through every rise (LeetCode 122). */
function best(prices: number[]) {
  return prices.slice(1).reduce((sum, p, i) => sum + Math.max(0, p - prices[i]), 0);
}

export function BestTimeDemo() {
  const [seed, setSeed] = useState(3);
  const [step, setStep] = useState(-1);
  const prices = useMemo(() => makePrices(seed), [seed]);
  const calls = useMemo(() => simulate(prices), [prices]);
  const top = useMemo(() => best(prices), [prices]);
  const done = step === N - 1;
  const cur = step >= 0 ? calls[step] : null;

  const markers: ChartMarker[] = calls
    .slice(0, step + 1)
    .filter((c) => c.action !== "nothing")
    .map((c) => ({ index: c.tick, label: c.action, tone: c.action === "buy" ? "bid" : "ask" }));
  const lit: readonly number[] = cur ? LINES[cur.action] : [];

  return (
    <div className="panel space-y-4 p-4">
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => setStep(step + 1)} disabled={done}>
          {step < 0 ? "Start" : "Next tick"}
        </button>
        <button className="btn" onClick={() => setStep(N - 1)} disabled={done}>
          Run to the end
        </button>
        <button className="btn" onClick={() => setStep(-1)} disabled={step < 0}>
          Reset
        </button>
        <button
          className="btn"
          onClick={() => {
            setSeed(seed + 1);
            setStep(-1);
          }}
        >
          New prices
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,33rem)]">
        <div className="min-w-0 space-y-3">
          <MiniChart values={prices} markers={markers} cursor={done ? undefined : step} dots label="Example prices" />
          <ol className="num max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {calls.slice(0, step + 1).map((c) => (
              <li key={c.tick} className={c.tick === step ? "text-foreground" : "text-muted"}>
                tick {c.tick}: run(state) with price {c.price} →{" "}
                <span className={c.action === "buy" ? "text-bid" : c.action === "sell" ? "text-ask" : ""}>
                  {c.action}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-sm">
            {!cur && "Press Start: run(state) is called once for every tick."}
            {cur && !done && `Score so far: ${cur.score}.`}
            {done &&
              `The template scored ${cur!.score} with one trade. The best possible was ${top}: own the unit through every rise and sell before every fall.`}
          </p>
        </div>
        <pre className="num h-fit overflow-x-auto rounded-md border border-border bg-background py-2 text-xs leading-relaxed">
          {RUN.map((line, i) => (
            <div key={i} className={`px-3 ${lit.includes(i) ? "bg-accent/15 text-accent" : ""}`}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
