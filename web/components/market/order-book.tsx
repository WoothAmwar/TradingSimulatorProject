import type { Book } from "@/lib/feed";

export function OrderBook({ book, levels = 6 }: { book?: Book; levels?: number }) {
  const asks = (book?.asks ?? []).slice(0, levels).reverse();
  const bids = (book?.bids ?? []).slice(0, levels);
  const maxQty = Math.max(1, ...asks.map((l) => l[1]), ...bids.map((l) => l[1]));
  const spread = bids[0] && book?.asks[0] ? book.asks[0][0] - bids[0][0] : null;

  const row = (price: number, qty: number, side: "bid" | "ask") => (
    <div key={`${side}${price}`} className="relative flex h-5 items-center justify-between px-2 text-xs">
      <div
        className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-bid/15" : "bg-ask/15"}`}
        style={{ width: `${(qty / maxQty) * 100}%` }}
      />
      <span className={`num relative ${side === "bid" ? "text-bid" : "text-ask"}`}>{price}</span>
      <span className="num relative text-muted">{qty}</span>
    </div>
  );
  // Empty slots keep the book one height as levels come and go, so the page below doesn't jump.
  const blanks = (shown: number, side: "bid" | "ask") =>
    Array.from({ length: levels - shown }, (_, i) => <div key={`${side}-blank${i}`} className="h-5" />);

  return (
    <div className="flex flex-col">
      <div className="flex justify-between px-2 pb-1 text-[10px] uppercase tracking-wide text-muted">
        <span>Price</span>
        <span>Qty</span>
      </div>
      {blanks(asks.length, "ask")}
      {asks.map(([p, q]) => row(p, q, "ask"))}
      <div className="num my-1 border-y border-border py-0.5 text-center text-[11px] text-muted">
        {!bids.length && !asks.length ? "No orders" : spread === null ? "—" : `gap ${spread}`}
      </div>
      {bids.map(([p, q]) => row(p, q, "bid"))}
      {blanks(bids.length, "bid")}
    </div>
  );
}
