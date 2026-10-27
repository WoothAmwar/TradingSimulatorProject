import type { Enums } from "@/lib/supabase/database.types";

export type Language = Enums<"bot_language">;

export const LANGUAGES: { id: Language; label: string; monaco: string }[] = [
  { id: "python", label: "Python", monaco: "python" },
  { id: "cpp", label: "C++", monaco: "cpp" },
  { id: "c", label: "C", monaco: "c" },
  { id: "java", label: "Java", monaco: "java" },
  { id: "go", label: "Go", monaco: "go" },
];

export const languageLabel = (id: string) => LANGUAGES.find((l) => l.id === id)?.label ?? id;
export const monacoLanguage = (id: string) => LANGUAGES.find((l) => l.id === id)?.monaco ?? id;

// Every template implements the same strategy: quote one tick inside the spread, sized by the
// room left under the position limit. Returning orders replaces all of your resting orders.
export const TEMPLATES: Record<Language, string> = {
  python: `from trader_sdk import Order, TradingState


class Trader:
    """One instance lives for the whole session; keep any state you need on self."""

    def __init__(self):
        self.ticks_seen = 0

    def run(self, state: TradingState) -> list[Order]:
        """Called every tick. Returned orders replace your resting orders.
        qty > 0 buys, qty < 0 sells. print() output shows up in the console."""
        self.ticks_seen += 1
        orders = []
        for good in state.goods:
            book = state.order_depths[good]
            if not book.bids or not book.asks:
                continue
            best_bid, best_ask = book.bids[0][0], book.asks[0][0]
            if best_ask - best_bid <= 2:
                continue
            position, limit = state.position[good], state.limits[good]
            buy = min(5, limit - position)
            sell = min(5, limit + position)
            if buy > 0:
                orders.append(Order(good, best_bid + 1, buy))
            if sell > 0:
                orders.append(Order(good, best_ask - 1, -sell))
        return orders
`,
  cpp: `#include "trader.hpp"
#include <algorithm>

// One instance lives for the whole session; keep any state you need as members.
class Trader {
public:
    // Called every tick. Returned orders replace your resting orders.
    // qty > 0 buys, qty < 0 sells. std::cout output shows up in the console.
    std::vector<Order> run(const State& s) {
        std::vector<Order> orders;
        for (const Good& g : s.goods) {
            if (g.bids.empty() || g.asks.empty()) continue;
            int bid = g.bids[0].price, ask = g.asks[0].price;
            if (ask - bid <= 2) continue;
            int buy = std::min(5, g.limit - g.position);
            int sell = std::min(5, g.limit + g.position);
            if (buy > 0) orders.push_back({g.name, bid + 1, buy});
            if (sell > 0) orders.push_back({g.name, ask - 1, -sell});
        }
        return orders;
    }
};
`,
  c: `#include "trader.h"

static int min_int(int a, int b) { return a < b ? a : b; }

/* Called once before the first tick. */
void trader_init(void) {}

/* Called every tick. add_order(out, good_index, price, qty): qty > 0 buys, qty < 0 sells.
   Returned orders replace your resting orders. printf output shows up in the console. */
void trader_run(const State *s, Orders *out) {
    for (int i = 0; i < s->num_goods; i++) {
        const Good *g = &s->goods[i];
        if (g->num_bids == 0 || g->num_asks == 0) continue;
        int bid = g->bids[0].price, ask = g->asks[0].price;
        if (ask - bid <= 2) continue;
        int buy = min_int(5, g->limit - g->position);
        int sell = min_int(5, g->limit + g->position);
        if (buy > 0) add_order(out, i, bid + 1, buy);
        if (sell > 0) add_order(out, i, ask - 1, -sell);
    }
}
`,
  java: `import java.util.*;

// One instance lives for the whole session; keep any state you need in fields.
public class Trader {
    // Called every tick. Returned orders replace your resting orders.
    // qty > 0 buys, qty < 0 sells. System.out output shows up in the console.
    public List<Order> run(State s) {
        List<Order> orders = new ArrayList<>();
        for (Good g : s.goods) {
            if (g.bids.isEmpty() || g.asks.isEmpty()) continue;
            int bid = g.bids.get(0).price, ask = g.asks.get(0).price;
            if (ask - bid <= 2) continue;
            int buy = Math.min(5, g.limit - g.position);
            int sell = Math.min(5, g.limit + g.position);
            if (buy > 0) orders.add(new Order(g.name, bid + 1, buy));
            if (sell > 0) orders.add(new Order(g.name, ask - 1, -sell));
        }
        return orders;
    }
}
`,
  go: `package main

// Trader lives for the whole session; keep any state you need in its fields.
type Trader struct{}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Run is called every tick. Returned orders replace your resting orders.
// Qty > 0 buys, Qty < 0 sells. fmt.Println output shows up in the console.
func (t *Trader) Run(s State) []Order {
	var orders []Order
	for _, g := range s.Goods {
		if len(g.Bids) == 0 || len(g.Asks) == 0 {
			continue
		}
		bid, ask := g.Bids[0].Price, g.Asks[0].Price
		if ask-bid <= 2 {
			continue
		}
		if buy := minInt(5, g.Limit-g.Position); buy > 0 {
			orders = append(orders, Order{Good: g.Name, Price: bid + 1, Qty: buy})
		}
		if sell := minInt(5, g.Limit+g.Position); sell > 0 {
			orders = append(orders, Order{Good: g.Name, Price: ask - 1, Qty: -sell})
		}
	}
	return orders
}
`,
};
