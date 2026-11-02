import { Ladder, type LadderRow } from "./ladder";

const ROWS: LadderRow[] = [
  { price: 1005, ask: 8 },
  { price: 1004, ask: 12, note: "computer" },
  { price: 1003 },
  { price: 1002, ask: 5, mine: "ask" },
  { price: 1001 },
  { price: 1000, note: "average" },
  { price: 999 },
  { price: 998, bid: 5, mine: "bid" },
  { price: 997 },
  { price: 996, bid: 12, note: "computer" },
  { price: 995, bid: 8 },
];

/** Where to quote in the flat-mean round: inside the bot maker's wide spread. */
export function FlatMeanDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
      <div className="panel p-3">
        <Ladder rows={ROWS} maxQty={12} />
      </div>
      <div className="space-y-2 text-sm">
        <p>
          The price stays near one average (1000 here). A computer trader always offers to buy at 996 and sell at
          1004, and other traders buy and sell every tick.
        </p>
        <p>
          Offer <span className="text-accent">better prices</span>, like 998 and 1002, and those traders deal with
          you first. Buy at 998, sell at 1002, and you earn 4 a unit.
        </p>
        <p>
          A wider gap earns more per trade but has to stay better than 996 and 1004. If you own a lot, offer lower so
          you sell more. Units you still own at the end count at the average.
        </p>
      </div>
    </div>
  );
}
