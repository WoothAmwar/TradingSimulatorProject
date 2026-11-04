import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Strategies · ACM Trading Simulator",
  description: "Trading ideas, good and bad, from simplest to most involved.",
};

type Strategy = { name: string; idea: string; bet: string; risk: string; uses: string[] };

// Simplest first. Deliberately NOT ordered (or labelled) by how well they do: some of these lose
// money, and the most involved ones aren't the best. Students find out by backtesting.
const STRATEGIES: Strategy[] = [
  {
    name: "Do nothing",
    idea: "Never send an order.",
    bet: "Nothing: your score stays at exactly 0.",
    risk: "It can't earn anything, but it's the yardstick every other bot should be compared with.",
    uses: [],
  },
  {
    name: "Buy and hold",
    idea: "Buy up to your limit at the start and keep the units until the end.",
    bet: "The price ending higher than you paid.",
    risk: "You pay the asking price to get in, and your whole score rides on the final price.",
    uses: ["state.best_ask", "state.can_buy"],
  },
  {
    name: "Coin flip",
    idea: "Every tick, pick at random: buy at the best ask, sell at the best bid, or do nothing.",
    bet: "Luck.",
    risk: "Each trade buys at the higher price or sells at the lower one. Try it to see what that gap costs.",
    uses: ["random", "state.best_bid", "state.best_ask"],
  },
  {
    name: "Chase the last move",
    idea: "If the price went up last tick, buy. If it went down, sell.",
    bet: "Moves continuing: up followed by more up.",
    risk: "It trades nearly every tick, and if moves tend to reverse, it buys just before drops.",
    uses: ["state.history"],
  },
  {
    name: "Fixed prices",
    idea: "Before the round, pick a buy price a little below the usual price in prices.csv and a sell price a little above it. Take any offer that reaches them.",
    bet: "The price coming back to the same level.",
    risk: "If the price settles somewhere new, one side never fills and you're stuck with what you hold.",
    uses: ["prices.csv", "state.best_bid", "state.best_ask"],
  },
  {
    name: "Jump the queue",
    idea: "Offer to buy 1 above the best bid and to sell 1 below the best ask, so you're first in line on both sides. This is the starter bot.",
    bet: "Both offers being taken about equally often, so you keep the gap between them.",
    risk: "When the price runs one way, only one side fills and you pile up units. Other teams can jump ahead of you too.",
    uses: ["state.best_bid", "state.best_ask", "state.can_buy", "state.can_sell"],
  },
  {
    name: "Breakout",
    idea: "Buy when the price rises above its highest point of the last N ticks. Sell when it drops below the lowest.",
    bet: "A new high or low starting a lasting move.",
    risk: "If the price pokes out of its range and falls back, you bought at the top (or sold at the bottom).",
    uses: ["state.history"],
  },
  {
    name: "Back to the average",
    idea: "Find the recent average and how far prices usually stray from it. Buy when the price is well below the average; sell when it's well above.",
    bet: "The price returning to its average.",
    risk: "If the price moves away and stays there, you keep buying until you hit your limit. How far counts as \"well below\" matters.",
    uses: ["state.history", "price_stats"],
  },
  {
    name: "Snipe cheap offers",
    idea: "Estimate what a unit is worth, say the recent average. Buy any offer to sell below it; sell to any offer to buy above it.",
    bet: "Your estimate being closer to the truth than the offers you take.",
    risk: "An offer can look cheap for a reason: one computer trader knows where the price is heading.",
    uses: ["state.history", "price_stats", "state.best_bid", "state.best_ask"],
  },
  {
    name: "Double down",
    idea: "Buy one unit. Each time the price falls further, buy twice as many as last time. Sell everything once the price is above what you paid on average.",
    bet: "The price bouncing back before you run out of room.",
    risk: "The sizes grow fast. If the price keeps falling, you hold the most units at the worst moment.",
    uses: ["state.my_trades", "state.position", "state.can_buy", "self"],
  },
  {
    name: "Lopsided offers",
    idea: "Add up the units on offer near the best prices. If buyers far outnumber sellers, buy; if sellers outnumber buyers, sell.",
    bet: "The heavier side pushing the price its way.",
    risk: "Big offers can sit for a long time without moving anything, and every trade crosses the gap.",
    uses: ["state.bids", "state.asks"],
  },
  {
    name: "Two averages",
    idea: "Track a short average (say the last 5 prices) and a long one (the last 50). Buy while the short one is above the long one; sell while it's below.",
    bet: "A rising price continuing to rise.",
    risk: "Averages lag, so signals arrive after the move. When the price wobbles, the two cross over and over.",
    uses: ["state.history", "price_stats"],
  },
  {
    name: "Follow the trades",
    idea: "Look at the trades since the last tick: trades above the price were buyers, below were sellers. If buyers dominate, buy; if sellers dominate, sell.",
    bet: "Busy traders knowing something, like the computer trader that sees ahead.",
    risk: "Most trades come from random traders, so the signal is noisy, and the price may have moved already.",
    uses: ["state.trades", "state.history"],
  },
  {
    name: "Quote around your own estimate",
    idea: "Estimate what a unit is worth, then keep an offer to buy a bit below it and to sell a bit above it. The more you hold, the lower you set both offers (higher when you owe).",
    bet: "Earning the gap between your offers many times, with the shift keeping your holdings small.",
    risk: "A bad estimate fills one side far more than the other. Too narrow a gap loses money per trade; too wide and nobody trades.",
    uses: ["state.history", "price_stats", "state.position", "state.can_buy", "state.can_sell"],
  },
  {
    name: "Pattern matching",
    idea: "Take the last few prices, search the history for the stretch that looks most like them, and bet the price does what it did next back then.",
    bet: "Price patterns repeating.",
    risk: "A long history always holds a close match, so you can find patterns that mean nothing.",
    uses: ["state.history"],
  },
];

export default function StrategiesPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8 pb-12 leading-relaxed text-foreground/90">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-accent">Ideas</p>
        <h1 className="text-3xl font-semibold">Strategies</h1>
        <p className="text-muted">
          Ideas to start from, simplest first. They are <strong>not</strong> ranked by how well they do: some lose
          money, and further down doesn&apos;t mean better. Backtest before you trust one, and expect STABLE, VOLATILE
          and other teams&apos; bots to change the answer. Fields are explained in{" "}
          <Link href="/about#template" className="text-accent hover:underline">
            How it works
          </Link>
          .
        </p>
      </header>

      <ol className="space-y-3">
        {STRATEGIES.map((s, i) => (
          <li key={s.name} className="panel space-y-2 p-4 text-sm">
            <h2 className="flex items-baseline gap-2 text-base font-semibold">
              <span className="num text-accent">{i + 1}</span>
              {s.name}
            </h2>
            <p>{s.idea}</p>
            <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted">Bets on</dt>
              <dd>{s.bet}</dd>
              <dt className="text-muted">Risk</dt>
              <dd>{s.risk}</dd>
              {s.uses.length > 0 && (
                <>
                  <dt className="text-muted">Uses</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {s.uses.map((u) => (
                      <code key={u} className="badge bg-panel-2 text-muted">
                        {u}
                      </code>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ol>
    </article>
  );
}
