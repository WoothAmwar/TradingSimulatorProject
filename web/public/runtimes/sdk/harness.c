/* Bridges the browser runtime and trader.c: parses the flat state text written into bot_input(),
 * calls trader_run(), and returns orders as "price qty" lines. Built as a WASI reactor. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "trader.h"

#define EXPORT(name) __attribute__((export_name(name)))
#define IN_CAP (1 << 20)

static char in_buf[IN_CAP];
static char out_buf[1 << 16];
static State state;
static Orders orders;
static char *cursor;
/* "Best time" rounds send every tick's price once, on the first tick; bots see it every tick. */
static int price_cache[MAX_PRICES];
static int price_count;

static int is_space(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }

static char *next_token(void) {
    while (*cursor && is_space(*cursor)) cursor++;
    if (!*cursor) return NULL;
    char *start = cursor;
    while (*cursor && !is_space(*cursor)) cursor++;
    if (*cursor) *cursor++ = '\0';
    return start;
}

static int next_is(char tag) {
    while (*cursor && is_space(*cursor)) cursor++;
    return cursor[0] == tag && is_space(cursor[1]);
}

static long long next_int(void) {
    char *t = next_token();
    return t ? strtoll(t, NULL, 10) : 0;
}

static int bounded(long long n, int max) { return n < 0 ? 0 : (n > max ? max : (int)n); }

/* Reads "<tag> n price qty price qty ..." into levels; returns how many were kept. */
static int parse_pairs(Level *levels, int max) {
    next_token(); /* section tag */
    long long n = next_int();
    for (long long k = 0; k < n; k++) {
        int price = (int)next_int(), qty = (int)next_int();
        if (k < max) levels[k] = (Level){price, qty};
    }
    return bounded(n, max);
}

static void parse_state(void) {
    cursor = in_buf;
    next_token(); /* T */
    state.tick = (int)next_int();
    state.cash = next_int();
    state.position = (int)next_int();
    state.limit = (int)next_int();
    state.num_bids = parse_pairs(state.bids, MAX_LEVELS);
    state.num_asks = parse_pairs(state.asks, MAX_LEVELS);
    state.num_trades = parse_pairs(state.trades, MAX_TRADES);
    if (next_is('P')) {
        next_token(); /* P */
        long long count = next_int();
        price_count = bounded(count, MAX_PRICES);
        for (long long k = 0; k < count; k++) {
            int price = (int)next_int();
            if (k < MAX_PRICES) price_cache[k] = price;
        }
    }
    state.prices = price_cache;
    state.num_prices = price_count;
    if (state.num_bids && state.num_asks) {
        state.price = (state.bids[0].price + state.asks[0].price) / 2.0;
    } else if (state.num_bids) {
        state.price = state.bids[0].price;
    } else {
        state.price = state.num_asks ? state.asks[0].price : 0;
    }
}

static void push(Orders *out, int price, int qty) {
    if (out->count < MAX_ORDERS && qty != 0) out->items[out->count++] = (Order){price, qty};
}

void buy(Orders *out, int price, int qty) { push(out, price, qty < 0 ? -qty : qty); }
void sell(Orders *out, int price, int qty) { push(out, price, qty < 0 ? qty : -qty); }

EXPORT("bot_input") char *bot_input(void) { return in_buf; }
EXPORT("bot_input_capacity") int bot_input_capacity(void) { return IN_CAP - 1; }

EXPORT("bot_init") void bot_init(void) {
    trader_init();
    fflush(stdout);
}

EXPORT("bot_tick") char *bot_tick(int len) {
    in_buf[len < IN_CAP ? len : IN_CAP - 1] = '\0';
    parse_state();
    orders.count = 0;
    trader_run(&state, &orders);
    fflush(stdout);
    fflush(stderr);
    size_t off = 0;
    out_buf[0] = '\0';
    for (int i = 0; i < orders.count && off < sizeof out_buf - 64; i++) {
        Order o = orders.items[i];
        off += (size_t)snprintf(out_buf + off, sizeof out_buf - off, "%d %d\n", o.price, o.qty);
    }
    return out_buf;
}
