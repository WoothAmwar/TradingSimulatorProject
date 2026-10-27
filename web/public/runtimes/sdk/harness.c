/* Bridges the browser runtime and trader.c: parses the flat state text written into bot_input(),
 * calls trader_run(), and returns orders as "good price qty ioc" lines. Built as a WASI reactor. */
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

static int is_space(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }

static char *next_token(void) {
    while (*cursor && is_space(*cursor)) cursor++;
    if (!*cursor) return NULL;
    char *start = cursor;
    while (*cursor && !is_space(*cursor)) cursor++;
    if (*cursor) *cursor++ = '\0';
    return start;
}

static long long next_int(void) {
    char *t = next_token();
    return t ? strtoll(t, NULL, 10) : 0;
}

static int bounded(long long n, int max) { return n < 0 ? 0 : (n > max ? max : (int)n); }

static void parse_levels(Level *levels, int *count) {
    next_token(); /* section tag */
    long long n = next_int();
    *count = bounded(n, MAX_LEVELS);
    for (long long k = 0; k < n; k++) {
        int price = (int)next_int(), qty = (int)next_int();
        if (k < MAX_LEVELS) levels[k] = (Level){price, qty};
    }
}

static void parse_state(void) {
    cursor = in_buf;
    next_token(); /* T */
    state.tick = (int)next_int();
    state.cash = next_int();
    long long goods = next_int();
    state.num_goods = bounded(goods, MAX_GOODS);
    for (long long i = 0; i < goods; i++) {
        static Good overflow;
        Good *g = i < MAX_GOODS ? &state.goods[i] : &overflow;
        next_token(); /* G */
        char *name = next_token();
        strncpy(g->name, name ? name : "", sizeof g->name - 1);
        g->name[sizeof g->name - 1] = '\0';
        g->position = (int)next_int();
        g->limit = (int)next_int();
        parse_levels(g->bids, &g->num_bids);
        parse_levels(g->asks, &g->num_asks);
        next_token(); /* X */
        long long n = next_int();
        g->num_trades = bounded(n, MAX_TRADES);
        for (long long k = 0; k < n; k++) {
            int price = (int)next_int(), qty = (int)next_int(), side = (int)next_int();
            if (k < MAX_TRADES) g->trades[k] = (Trade){price, qty, side};
        }
    }
}

static void push(Orders *out, int good, int price, int qty, int ioc) {
    if (out->count < MAX_ORDERS && qty != 0 && good >= 0 && good < state.num_goods) {
        out->items[out->count++] = (Order){good, price, qty, ioc};
    }
}

void add_order(Orders *out, int good, int price, int qty) { push(out, good, price, qty, 0); }
void add_ioc_order(Orders *out, int good, int price, int qty) { push(out, good, price, qty, 1); }

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
        off += (size_t)snprintf(out_buf + off, sizeof out_buf - off, "%d %d %d %d\n", o.good,
                                o.price, o.qty, o.ioc);
    }
    return out_buf;
}
