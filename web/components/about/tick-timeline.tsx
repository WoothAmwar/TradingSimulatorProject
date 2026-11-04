const EXAMPLE = [
  { tick: 0, answer: "buy" },
  { tick: 1, answer: "nothing" },
  { tick: 2, answer: "sell" },
  { tick: 3, answer: "buy + sell" },
  { tick: 4, answer: "nothing" },
];

const STEPS = [
  {
    title: "1. The market updates",
    body: "The computer trader moves its offers to the new price, trading with any of yours left at an old one.",
  },
  { title: "2. run(state) is called", body: "Your bot sees the market and returns orders, or []." },
  { title: "3. Orders trade", body: "Offers that match trade, best price first." },
  { title: "4. Others arrive", body: "Other traders may trade with your offers." },
];

/** run(state) is called once per tick, in every round: the strip of ticks, then one tick's steps. */
export function TickTimeline() {
  return (
    <div className="space-y-3">
      <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Every tick calls run(state)">
        {EXAMPLE.map(({ tick, answer }) => (
          <li key={tick} className="w-28 shrink-0 rounded-md border border-border bg-panel-2 p-2 text-center">
            <div className="num text-xs text-muted">tick {tick}</div>
            <div className="num my-1 rounded bg-accent/15 py-0.5 text-xs text-accent">run(state)</div>
            <div className="text-xs">→ {answer}</div>
          </li>
        ))}
        <li className="flex w-10 shrink-0 items-center justify-center text-muted">…</li>
      </ol>
      <ol className="grid gap-2 md:grid-cols-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="rounded-md border border-border bg-panel-2 p-3 text-sm">
            <div className={`font-semibold ${i === 1 ? "text-accent" : ""}`}>{step.title}</div>
            <p className="mt-1 text-xs text-foreground/80">{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">
        Every round works this way. In the live round a tick lasts about a second; in static rounds your browser
        runs every tick in a few seconds.
      </p>
    </div>
  );
}
