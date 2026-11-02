import type { StaticPreset } from "@/lib/lobby";

/** Languages that run in the browser. */
export type Language = "python" | "cpp" | "c";

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "cpp", label: "C++" },
  { id: "c", label: "C" },
];

// Older submissions may be in Java or Go, which can no longer be picked.
const LABELS: Record<string, string> = { python: "Python", cpp: "C++", c: "C", java: "Java", go: "Go" };
export const languageLabel = (id: string) => LABELS[id] ?? id;
export const isLanguage = (id: string): id is Language => LANGUAGES.some((l) => l.id === id);

/** What a Python bot's `state` holds. Generates the templates' reference and the /about table. */
export const PY_STATE_FIELDS: { name: string; type: string; meaning: string }[] = [
  { name: "state.tick", type: "int", meaning: "Tick number: 0, 1, 2, ..." },
  { name: "state.price", type: "float", meaning: "Current price: halfway between the best bid and ask." },
  { name: "state.bids", type: "list of (price, qty)", meaning: "Offers to buy, highest price first." },
  { name: "state.asks", type: "list of (price, qty)", meaning: "Offers to sell, lowest price first." },
  { name: "state.position", type: "int", meaning: "Units you own (below 0: you owe units)." },
  { name: "state.limit", type: "int", meaning: "The most units you may own, or owe." },
  { name: "state.cash", type: "int", meaning: "Money from selling minus money spent buying." },
  { name: "state.trades", type: "list of (price, qty)", meaning: "Everyone's trades since the last tick." },
  { name: "state.my_trades", type: "list of (price, qty)", meaning: "Your trades since the last tick (qty < 0: sold)." },
];

export const PY_PRICES_FIELD = {
  name: "state.prices",
  type: "list of int",
  meaning: "Best-time rounds: every tick's price, past and future.",
};

const pyRow = (f: { name: string; type: string; meaning: string }) =>
  `    ${f.name.padEnd(18)}${f.type.padEnd(22)}${f.meaning}`;

const PY_STATE = `STATE: what run(state) gets every tick
${PY_STATE_FIELDS.map(pyRow).join("\n")}`;

const PY_RETURN = `RETURN: a list of orders such as [buy(99, 5), sell(103, 5)], or [] for none.
    They replace last tick's orders. Orders that could take you past the limit are rejected.`;

const CPP_STATE = `// STATE: what run(s) gets every tick
//   s.tick       int             tick number: 0, 1, 2, ...
//   s.price      double          current price: halfway between the best bid and ask
//   s.bids       vector<Level>   offers to buy {price, qty}, highest price first
//   s.asks       vector<Level>   offers to sell {price, qty}, lowest price first
//   s.position   int             units you own (below 0: you owe units)
//   s.limit      int             the most units you may own, or owe
//   s.cash       long long       money from selling minus money spent buying
//   s.trades     vector<Trade>   everyone's trades {price, qty} since the last tick`;

const CPP_RETURN = `// RETURN: a vector of orders such as {buy(99, 5), sell(103, 5)}, or {} for none.
//   They replace last tick's orders. Orders that could take you past the limit are rejected.`;

const C_STATE = `/* STATE: what trader_run(s, out) gets every tick
 *   s->tick         int        tick number: 0, 1, 2, ...
 *   s->price        double     current price: halfway between the best bid and ask
 *   s->bids[i]      Level      offers to buy {price, qty}, highest first (i < s->num_bids)
 *   s->asks[i]      Level      offers to sell {price, qty}, lowest first (i < s->num_asks)
 *   s->position     int        units you own (below 0: you owe units)
 *   s->limit        int        the most units you may own, or owe
 *   s->cash         long long  money from selling minus money spent buying
 *   s->trades[i]    Trade      everyone's recent trades {price, qty} (i < s->num_trades) */`;

const C_RETURN = `/* RETURN: call buy(out, price, qty) or sell(out, price, qty) for each order, or neither.
 *   They replace last tick's orders. Orders that could take you past the limit are rejected. */`;

// The starter strategy in every language: offer to buy one above the best bid and to sell one below
// the best ask, so other traders deal with this bot first. Sizes stay inside the limit.
export const TEMPLATES: Record<Language, string> = {
  python: `"""Starter bot: offers to buy just above the best bid and to sell just below the best ask,
so other traders deal with it first.

${PY_STATE}

${PY_RETURN}
"""
from trader_sdk import buy, sell

SIZE = 5  # units per order


class Trader:
    def run(self, state):
        """Called every tick. Return the orders you want, or [] to do nothing."""
        if not state.bids or not state.asks:
            return []
        best_bid = state.bids[0][0]  # highest price someone will pay
        best_ask = state.asks[0][0]  # lowest price someone will sell for
        if best_ask - best_bid <= 2:  # no room to squeeze in between
            return []
        orders = []
        room_to_buy = state.limit - state.position
        room_to_sell = state.limit + state.position
        if room_to_buy > 0:
            orders.append(buy(best_bid + 1, min(SIZE, room_to_buy)))
        if room_to_sell > 0:
            orders.append(sell(best_ask - 1, min(SIZE, room_to_sell)))
        return orders
`,
  cpp: `#include "trader.hpp"
#include <algorithm>

// Starter bot: offers to buy just above the best bid and to sell just below the best ask,
// so other traders deal with it first.
//
${CPP_STATE}
//
${CPP_RETURN}

const int SIZE = 5;  // units per order

class Trader {
public:
    // Called every tick. Return the orders you want, or {} to do nothing.
    std::vector<Order> run(const State& s) {
        if (s.bids.empty() || s.asks.empty()) return {};
        int best_bid = s.bids[0].price;  // highest price someone will pay
        int best_ask = s.asks[0].price;  // lowest price someone will sell for
        if (best_ask - best_bid <= 2) return {};  // no room to squeeze in between
        std::vector<Order> orders;
        int room_to_buy = s.limit - s.position;
        int room_to_sell = s.limit + s.position;
        if (room_to_buy > 0) orders.push_back(buy(best_bid + 1, std::min(SIZE, room_to_buy)));
        if (room_to_sell > 0) orders.push_back(sell(best_ask - 1, std::min(SIZE, room_to_sell)));
        return orders;
    }
};
`,
  c: `#include "trader.h"

/* Starter bot: offers to buy just above the best bid and to sell just below the best ask,
 * so other traders deal with it first. */

${C_STATE}

${C_RETURN}

#define SIZE 5 /* units per order */

static int min_int(int a, int b) { return a < b ? a : b; }

/* Called once, before the first tick. */
void trader_init(void) {}

/* Called every tick. Add the orders you want, or none to do nothing. */
void trader_run(const State *s, Orders *out) {
    if (s->num_bids == 0 || s->num_asks == 0) return;
    int best_bid = s->bids[0].price; /* highest price someone will pay */
    int best_ask = s->asks[0].price; /* lowest price someone will sell for */
    if (best_ask - best_bid <= 2) return; /* no room to squeeze in between */
    int room_to_buy = s->limit - s->position;
    int room_to_sell = s->limit + s->position;
    if (room_to_buy > 0) buy(out, best_bid + 1, min_int(SIZE, room_to_buy));
    if (room_to_sell > 0) sell(out, best_ask - 1, min_int(SIZE, room_to_sell));
}
`,
};

/** Starter code for static rounds. */
export const STATIC_TEMPLATES: Record<StaticPreset, Record<Language, string>> = {
  BEST_TIME: {
    python: `"""Static round: best time to buy and sell. Own at most one unit; trade as often as you like.

${PY_STATE}
${pyRow(PY_PRICES_FIELD)}
"""
from trader_sdk import buy, sell


class Trader:
    def __init__(self):
        self.sold = False  # remembered between ticks; this starter trades only once

    def is_highest_from_now(self, prices, tick):
        """Helper: True if no later tick has a higher price."""
        return prices[tick] >= max(prices[tick:])

    def run(self, state):
        """Called every tick: buy, sell or do nothing."""
        if state.position == 0 and not self.sold:
            return [buy(state.price, 1)]  # buy straight away
        if state.position == 1 and self.is_highest_from_now(state.prices, state.tick):
            self.sold = True
            return [sell(state.price, 1)]  # sell when the price won't get any higher
        return []
`,
    cpp: `#include "trader.hpp"

// Static round: best time to buy and sell. Own at most one unit; trade as often as you like.
//
${CPP_STATE}
//   s.prices     vector<int>     best-time rounds: every tick's price, past and future

class Trader {
    bool sold = false;  // remembered between ticks

    // Helper: true if no later tick has a higher price.
    bool is_highest_from_now(const std::vector<int>& prices, int tick) {
        for (int t = tick; t < (int)prices.size(); t++) {
            if (prices[t] > prices[tick]) return false;
        }
        return true;
    }

public:
    // Called every tick: buy, sell or do nothing.
    std::vector<Order> run(const State& s) {
        int price = (int)s.price;
        if (s.position == 0 && !sold) return {buy(price, 1)};  // buy straight away
        if (s.position == 1 && is_highest_from_now(s.prices, s.tick)) {
            sold = true;
            return {sell(price, 1)};  // sell when the price won't get any higher
        }
        return {};
    }
};
`,
    c: `#include "trader.h"

/* Static round: best time to buy and sell. Own at most one unit; trade as often as you like. */

${C_STATE.replace(" */", "")}
 *   s->prices[i]    int        best-time rounds: every tick's price (i < s->num_prices) */

static int sold = 0; /* remembered between ticks */

/* Helper: 1 if no later tick has a higher price. */
static int is_highest_from_now(const int *prices, int n, int tick) {
    for (int t = tick; t < n; t++) {
        if (prices[t] > prices[tick]) return 0;
    }
    return 1;
}

void trader_init(void) {}

/* Called every tick: buy, sell or do nothing. */
void trader_run(const State *s, Orders *out) {
    int price = (int)s->price;
    if (s->position == 0 && !sold) {
        buy(out, price, 1); /* buy straight away */
    } else if (s->position == 1 && is_highest_from_now(s->prices, s->num_prices, s->tick)) {
        sold = 1;
        sell(out, price, 1); /* sell when the price won't get any higher */
    }
}
`,
  },
  FLAT_MEAN: {
    python: `"""Static round: the price stays near one average. Buy a bit below it, sell a bit above.

${PY_STATE}
"""
from trader_sdk import buy, sell

EDGE = 2  # how far from the average to place orders
SIZE = 5  # units per order


class Trader:
    def __init__(self):
        self.total = 0.0  # sum of the prices seen so far (remembered between ticks)
        self.count = 0

    def run(self, state):
        """Called every tick."""
        if state.bids and state.asks:
            self.total += state.price
            self.count += 1
        if self.count == 0:
            return []
        average = int(self.total / self.count + 0.5)  # estimate of the fixed average price
        lean = int(state.position / 10)  # own a lot? offer lower so you sell more
        orders = []
        room_to_buy = state.limit - state.position
        room_to_sell = state.limit + state.position
        if room_to_buy > 0:
            orders.append(buy(average - EDGE - lean, min(SIZE, room_to_buy)))
        if room_to_sell > 0:
            orders.append(sell(average + EDGE - lean, min(SIZE, room_to_sell)))
        return orders
`,
    cpp: `#include "trader.hpp"
#include <algorithm>

// Static round: the price stays near one average. Buy a bit below it, sell a bit above.
//
${CPP_STATE}

const int EDGE = 2;  // how far from the average to place orders
const int SIZE = 5;  // units per order

class Trader {
    double total = 0;  // sum of the prices seen so far (remembered between ticks)
    int count = 0;

public:
    // Called every tick.
    std::vector<Order> run(const State& s) {
        if (!s.bids.empty() && !s.asks.empty()) {
            total += s.price;
            count += 1;
        }
        if (count == 0) return {};
        int average = (int)(total / count + 0.5);  // estimate of the fixed average price
        int lean = s.position / 10;  // own a lot? offer lower so you sell more
        std::vector<Order> orders;
        int room_to_buy = s.limit - s.position;
        int room_to_sell = s.limit + s.position;
        if (room_to_buy > 0) {
            orders.push_back(buy(average - EDGE - lean, std::min(SIZE, room_to_buy)));
        }
        if (room_to_sell > 0) {
            orders.push_back(sell(average + EDGE - lean, std::min(SIZE, room_to_sell)));
        }
        return orders;
    }
};
`,
    c: `#include "trader.h"

/* Static round: the price stays near one average. Buy a bit below it, sell a bit above. */

${C_STATE}

#define EDGE 2 /* how far from the average to place orders */
#define SIZE 5 /* units per order */

static double total = 0; /* sum of the prices seen so far (remembered between ticks) */
static int count = 0;

static int min_int(int a, int b) { return a < b ? a : b; }

void trader_init(void) {}

/* Called every tick. */
void trader_run(const State *s, Orders *out) {
    if (s->num_bids > 0 && s->num_asks > 0) {
        total += s->price;
        count++;
    }
    if (count == 0) return;
    int average = (int)(total / count + 0.5); /* estimate of the fixed average price */
    int lean = s->position / 10; /* own a lot? offer lower so you sell more */
    int room_to_buy = s->limit - s->position;
    int room_to_sell = s->limit + s->position;
    if (room_to_buy > 0) buy(out, average - EDGE - lean, min_int(SIZE, room_to_buy));
    if (room_to_sell > 0) sell(out, average + EDGE - lean, min_int(SIZE, room_to_sell));
}
`,
  },
};

/** Where a piece of code will run: the live market, or one static round. */
export type CodeTarget = { kind: "live" } | { kind: "static"; preset: StaticPreset };

export function templateFor(target: CodeTarget, language: Language): string {
  return target.kind === "live" ? TEMPLATES[language] : STATIC_TEMPLATES[target.preset][language];
}
