/** One price row of a mock order book. `bid`/`ask` are resting quantities; `mine` marks your quote. */
export type LadderRow = { price: number; bid?: number; ask?: number; mine?: "bid" | "ask"; note?: string };

/** A vertical order book: asks above, bids below, quantity bars growing out from the price column. */
export function Ladder({ rows, maxQty }: { rows: LadderRow[]; maxQty?: number }) {
  const max = maxQty ?? Math.max(1, ...rows.map((r) => Math.max(r.bid ?? 0, r.ask ?? 0)));
  return (
    <div className="num text-xs">
      <div className="grid grid-cols-[1fr_4rem_1fr] px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">
        <span>Bids (buy)</span>
        <span className="text-center">Price</span>
        <span className="text-right">Asks (sell)</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.price}
          className={`grid grid-cols-[1fr_4rem_1fr] items-center gap-1 rounded px-1 py-0.5 ${r.mine ? "bg-accent/10 ring-1 ring-accent/60" : ""}`}
        >
          <Bar qty={r.bid} max={max} side="bid" mine={r.mine === "bid"} />
          <span className="text-center">
            {r.price}
            {r.note && <span className="block text-[9px] leading-tight text-muted">{r.note}</span>}
          </span>
          <Bar qty={r.ask} max={max} side="ask" mine={r.mine === "ask"} />
        </div>
      ))}
    </div>
  );
}

function Bar({ qty, max, side, mine }: { qty?: number; max: number; side: "bid" | "ask"; mine: boolean }) {
  if (!qty) return <span />;
  const color = mine ? "bg-accent/60" : side === "bid" ? "bg-bid/35" : "bg-ask/35";
  return (
    <div className={`flex items-center gap-1 ${side === "bid" ? "flex-row-reverse" : ""}`}>
      <div className={`h-3 rounded-sm ${color}`} style={{ width: `${Math.max(8, (100 * qty) / max)}%` }} />
      <span className={mine ? "text-accent" : "text-muted"}>
        {qty}
        {mine && " you"}
      </span>
    </div>
  );
}
