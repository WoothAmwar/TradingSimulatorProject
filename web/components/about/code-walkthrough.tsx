import { PY_STATE_FIELDS, TEMPLATES } from "@/lib/templates";

// Each note starts at the first template line containing its anchor and runs until the next one.
const NOTES: { anchor: string; note: string }[] = [
  { anchor: '"""Starter bot', note: "A comment listing everything in state and what to return. Python ignores it." },
  {
    anchor: "from trader_sdk import buy, sell",
    note: "buy(price, qty) and sell(price, qty) make orders: offers to buy or sell qty units at that price.",
  },
  { anchor: "SIZE = 5", note: "How many units to offer each time." },
  {
    anchor: "class Trader:",
    note: "Your code needs a class called Trader. One copy lives for the whole round, so anything stored on self is remembered between ticks.",
  },
  {
    anchor: "def run(self, state):",
    note: "Called every tick, in every round. It gets the market as it is now and returns orders.",
  },
  { anchor: "if not state.bids or not state.asks:", note: "If nobody is offering to buy, or to sell, do nothing." },
  {
    anchor: "if state.best_ask - state.best_bid <= 2:",
    note: "best_bid is the highest price anyone will pay; best_ask, the lowest anyone will sell for. With a gap of 2 or less there's no room for better offers in between.",
  },
  { anchor: "orders = []", note: "Collect this tick's orders." },
  {
    anchor: "if state.can_buy > 0:",
    note: "can_buy: how many more units you may buy. Offer to buy at 1 above the best bid, so sellers come to you first.",
  },
  {
    anchor: "if state.can_sell > 0:",
    note: "can_sell: how many you may sell (you can owe up to the limit). Offer to sell at 1 below the best ask, so buyers come to you first.",
  },
  {
    anchor: "return orders",
    note: "These replace last tick's orders. Next tick, run() is called again with the new market.",
  },
];

function blocks() {
  const lines = TEMPLATES.python.trimEnd().split("\n");
  let previous = -1;
  const starts = NOTES.map(({ anchor, note }) => {
    const at = lines.findIndex((l, k) => k > previous && l.includes(anchor));
    // Fails the build if the template changes without this walkthrough.
    if (at < 0) throw new Error(`Walkthrough anchor not found in the Python template: ${anchor}`);
    previous = at;
    return { at, note };
  });
  return starts.map(({ at, note }, i) => {
    const block = lines.slice(at, i + 1 < starts.length ? starts[i + 1].at : lines.length);
    while (block.length > 1 && !block[block.length - 1].trim()) block.pop();
    return { first: at + 1, lines: block, note };
  });
}

/** The real Python template, split into commented blocks. */
export function CodeWalkthrough() {
  return (
    <div className="panel divide-y divide-border overflow-hidden">
      {blocks().map((b, i) => {
        const code = (
          <pre className="num overflow-x-auto px-3 py-2 text-xs leading-relaxed">
            {b.lines.map((line, k) => (
              <div key={k} className="flex">
                <span className="w-8 shrink-0 select-none pr-3 text-right text-muted/60">{b.first + k}</span>
                <span className="whitespace-pre">{line || " "}</span>
              </div>
            ))}
          </pre>
        );
        return (
          <div key={b.first} className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
            {i === 0 ? (
              <details className="min-w-0">
                <summary className="cursor-pointer px-3 py-2 text-xs text-muted hover:text-foreground">
                  Lines {b.first}–{b.first + b.lines.length - 1}: the reference comment (click to expand)
                </summary>
                {code}
              </details>
            ) : (
              <div className="min-w-0">{code}</div>
            )}
            <p className="border-border bg-panel-2/50 px-3 py-2 text-sm md:border-l">{b.note}</p>
          </div>
        );
      })}
    </div>
  );
}

/** Every field of a Python bot's state. Generated from the same list as the templates' reference. */
export function StateReference() {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Meaning</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {PY_STATE_FIELDS.map((f) => (
            <tr key={f.name}>
              <td className="num whitespace-nowrap px-3 py-2 text-accent">{f.name}</td>
              <td className="num whitespace-nowrap px-3 py-2 text-muted">{f.type}</td>
              <td className="px-3 py-2">{f.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
