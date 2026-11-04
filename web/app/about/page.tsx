import type { Metadata } from "next";
import Link from "next/link";
import { BestTimeDemo } from "@/components/about/best-time-demo";
import { BookDiagram } from "@/components/about/book-diagram";
import { CodeWalkthrough, StateReference } from "@/components/about/code-walkthrough";
import { FlatMeanDemo } from "@/components/about/flat-mean-demo";
import { MockSession } from "@/components/about/mock-session";
import { PricePaths } from "@/components/about/price-paths";
import { TickTimeline } from "@/components/about/tick-timeline";
import { PY_HELPER } from "@/lib/templates";

export const metadata: Metadata = {
  title: "How it works · ACM Trading Simulator",
  description: "The game, the market and the starter bot, explained without finance jargon.",
};

const SECTIONS = [
  ["game", "The game"],
  ["market", "How the market works"],
  ["session", "Six ticks, step by step"],
  ["template", "The starter bot"],
  ["tips", "Tips"],
  ["static", "Static rounds"],
  ["start", "Getting started"],
] as const;

function Section({ id, children }: { id: (typeof SECTIONS)[number][0]; children: React.ReactNode }) {
  const index = SECTIONS.findIndex(([s]) => s === id);
  return (
    <section id={id} className="scroll-mt-6 space-y-4">
      <h2 className="text-xl font-semibold">
        <span className="num mr-2 text-accent">{index + 1}</span>
        {SECTIONS[index][1]}
      </h2>
      {children}
    </section>
  );
}

function Snippet({ children }: { children: string }) {
  return (
    <pre className="num overflow-x-auto rounded-md border border-border bg-background p-3 text-xs leading-relaxed">
      {children}
    </pre>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel min-w-0 space-y-2 p-4 text-sm">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-5xl space-y-12 pb-12 leading-relaxed text-foreground/90">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-accent">Tutorial</p>
        <h1 className="text-3xl font-semibold">How the trading simulator works</h1>
        <p className="max-w-3xl text-muted">
          Everything you need to write your first bot in about ten minutes. No finance background needed.
        </p>
        <nav className="flex flex-wrap gap-2 pt-2 text-sm">
          {SECTIONS.map(([id, title], i) => (
            <a key={id} href={`#${id}`} className="btn">
              <span className="num text-accent">{i + 1}</span>
              {title}
            </a>
          ))}
        </nav>
      </header>

      <Section id="game">
        <ul className="max-w-3xl list-disc space-y-1 pl-5">
          <li>
            Your team writes a <strong>bot</strong>: a small program that buys and sells one item on a pretend
            market.
          </li>
          <li>
            Time moves in steps called <strong>ticks</strong>. Every tick, your bot&apos;s <code>run(state)</code> is
            called with what the market looks like right now, and it answers: buy, sell, or do nothing.
          </li>
          <li>
            You start with no money and no units. At the end, <strong>score = your money + what your units are
            worth</strong>. Buy low, sell high.
          </li>
          <li>
            In the <strong>live round</strong> every team trades in one market at once. A{" "}
            <strong>static round</strong> is a fixed market you can study first; each has its own code and score.
          </li>
        </ul>
        <div className="panel max-w-md p-4">
          <table className="num w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="pb-1 font-normal">Example</th>
                <th className="pb-1 text-right font-normal">money</th>
                <th className="pb-1 text-right font-normal">units</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Buy 3 at 100</td>
                <td className="text-right">−300</td>
                <td className="text-right">3</td>
              </tr>
              <tr>
                <td>Sell 2 at 104</td>
                <td className="text-right">−92</td>
                <td className="text-right">1</td>
              </tr>
              <tr className="border-t border-border">
                <td className="pt-1">End: a unit is worth 101</td>
                <td colSpan={2} className="pt-1 text-right text-bid">
                  score −92 + 101 = 9
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="market">
        <BookDiagram />
        <h3 className="font-semibold">Every tick, in every round</h3>
        <TickTimeline />
        <ul className="max-w-3xl list-disc space-y-1 pl-5 text-sm">
          <li>
            An offer stays on the market until someone takes it or your next answer replaces it. Sending the same
            offer again keeps its place in line: at one price, the oldest offer trades first. If your bot doesn&apos;t
            answer in time (it&apos;s still busy or too slow), its run() fails, or it crashes, its offers are cancelled.
          </li>
          <li>Your bot sees the market without its own offers.</li>
          <li>
            Computer traders take part too: one always offers to buy and sell, others trade at random, and one knows
            where the price is heading.
          </li>
          <li>
            You can&apos;t own more than <code>state.limit</code> units, or owe more than that. Orders that could
            break the limit are refused.
          </li>
          <li>
            A buy priced more than 1% above the current price is moved down to that 1% mark (a sell, up to 1% below),
            so one stray order can&apos;t trade at an absurd price.
          </li>
        </ul>
      </Section>

      <Section id="session">
        <p className="max-w-3xl">The starter bot trading a made-up market, with a limit of 10 units.</p>
        <MockSession />
      </Section>

      <Section id="template">
        <p className="max-w-3xl">The Python starter bot from the editor. C and C++ work the same way.</p>
        <CodeWalkthrough />
        <h3 className="pt-2 font-semibold">Everything in state</h3>
        <StateReference />
        <p className="max-w-3xl text-sm text-muted">
          In best-time rounds there is also <code>state.prices</code>: every tick&apos;s price, past and future.
        </p>
        <p className="max-w-3xl text-sm text-muted">
          Helper: <code>{PY_HELPER.call}</code>. {PY_HELPER.meaning} Import it with{" "}
          <code>from trader_sdk import price_stats</code>.
        </p>
      </Section>

      <Section id="tips">
        <PricePaths />
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Work out what it's worth">
            <p>Average the price over recent ticks instead of trusting one moment.</p>
            <Snippet>{`self.worth = 0.95 * self.worth + 0.05 * state.price`}</Snippet>
          </Card>
          <Card title="Buy below it, sell above it">
            <p>A wider gap earns more per trade, but fewer people take your offers.</p>
            <Snippet>{`return [buy(round(self.worth) - 2, 5),
        sell(round(self.worth) + 2, 5)]`}</Snippet>
          </Card>
          <Card title="Don't hold too much">
            <p>If you own a lot, offer lower prices so you sell more. If you owe a lot, offer higher.</p>
          </Card>
          <Card title="Watch out for know-it-alls">
            <p>If you keep buying right before the price drops, someone knows more than you. Offer less or wait.</p>
          </Card>
        </div>
        <p className="max-w-3xl text-sm text-muted">
          Test every change with the backtest button. You can also download the market data from the editor. More
          ideas, good and bad: <Link href="/strategies" className="text-accent hover:underline">Strategies</Link>.
        </p>
      </Section>

      <Section id="static">
        <p className="max-w-3xl">
          Pick a static round in the editor&apos;s <strong>Round</strong> menu to get its own starter code.{" "}
          <strong>Save &amp; submit</strong> runs your bot over the whole round; your latest submission is your score.
        </p>

        <h3 className="text-lg font-semibold">Best time to buy and sell</h3>
        <p className="max-w-3xl">
          One price per tick. You can own at most one unit, but you may buy and sell it as often as you like.{" "}
          <code>state.prices</code> gives every tick&apos;s price, so your bot can plan ahead; each tick, it still
          answers buy, sell or nothing. The best possible score is the sum of every price rise (LeetCode 122, Best
          Time to Buy and Sell Stock II). The starter below trades only once.
        </p>
        <BestTimeDemo />

        <h3 className="pt-2 text-lg font-semibold">Steady average</h3>
        <FlatMeanDemo />
      </Section>

      <Section id="start">
        <ol className="max-w-3xl list-decimal space-y-1 pl-5">
          <li>
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>{" "}
            and open your team&apos;s invite link.
          </li>
          <li>
            In <strong>Code &amp; backtest</strong>, run the starter bot, improve it and save it.
          </li>
          <li>
            On <strong>Overview</strong>, choose it as your team&apos;s bot for the live round.
          </li>
          <li>
            During the live round the exchange runs it for you; watch it in <strong>Live trading</strong>.
          </li>
          <li>
            For static rounds, pick the round in the editor and <strong>Save &amp; submit</strong> while it&apos;s open.
          </li>
        </ol>
      </Section>
    </article>
  );
}
