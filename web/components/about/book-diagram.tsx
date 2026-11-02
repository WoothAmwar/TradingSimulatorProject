"use client";

import { useState } from "react";
import { Ladder, type LadderRow } from "./ladder";

const BIDS: Record<number, number> = { 99: 10, 98: 14, 97: 6 };
const ASKS: Record<number, number> = { 103: 9, 104: 12, 105: 7 };

/** A mock book with an optional overlay of the starter bot's quotes (best bid + 1, best ask - 1). */
export function BookDiagram() {
  const [quotes, setQuotes] = useState(false);
  const rows: LadderRow[] = [];
  for (let price = 105; price >= 97; price--) {
    const row: LadderRow = { price, bid: BIDS[price], ask: ASKS[price] };
    if (price === 101) row.note = "price";
    if (quotes && price === 102) Object.assign(row, { ask: 5, mine: "ask" });
    if (quotes && price === 100) Object.assign(row, { bid: 5, mine: "bid" });
    rows.push(row);
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
      <div className="panel p-3">
        <Ladder rows={rows} maxQty={14} />
        <button className="btn mt-3 w-full" onClick={() => setQuotes(!quotes)}>
          {quotes ? "Hide" : "Show"} the starter bot&apos;s offers
        </button>
      </div>
      <div className="space-y-2 text-sm">
        <p>
          The market is a list of offers. <span className="text-bid">Bids</span> are offers to buy;{" "}
          <span className="text-ask">asks</span> are offers to sell.
        </p>
        <p>
          Here someone will buy 10 units at 99 (the <strong>best bid</strong>) and someone will sell 9 at 103 (the{" "}
          <strong>best ask</strong>). The current price, <code>state.price</code>, is halfway: 101.
        </p>
        <p>
          {quotes ? (
            <>
              The starter bot offers to <span className="text-accent">buy at 100 and sell at 102</span>, better than
              anyone else, so the next trader deals with it first. Buying at 100 and selling at 102 earns 2 a unit.
            </>
          ) : (
            <>Press the button to see where the starter bot makes its offers.</>
          )}
        </p>
      </div>
    </div>
  );
}
