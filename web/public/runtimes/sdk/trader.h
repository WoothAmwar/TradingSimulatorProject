/* ACM Trading Simulator — C bot API.
 *
 * Implement trader_init() and trader_run() in your file. trader_run() is called once per tick;
 * add orders with add_order() (GTC limit) or add_ioc_order() (immediate-or-cancel). The orders
 * you return replace all of your resting orders. qty > 0 buys, qty < 0 sells.
 * printf() output appears in the console.
 */
#ifndef TRADER_H
#define TRADER_H

#define MAX_GOODS 8
#define MAX_LEVELS 64
#define MAX_TRADES 128
#define MAX_ORDERS 64

typedef struct {
    int price;
    int qty;
} Level;

typedef struct {
    int price;
    int qty;
    int side; /* +1: the buyer crossed the spread, -1: the seller did */
} Trade;

typedef struct {
    char name[32];
    int position;
    int limit; /* |position| may never exceed this */
    int num_bids, num_asks, num_trades;
    Level bids[MAX_LEVELS]; /* best (highest) first */
    Level asks[MAX_LEVELS]; /* best (lowest) first */
    Trade trades[MAX_TRADES]; /* market trades since the last tick */
} Good;

typedef struct {
    int tick;
    long long cash;
    int num_goods;
    Good goods[MAX_GOODS];
} State;

typedef struct {
    int good; /* index into State.goods */
    int price;
    int qty;
    int ioc;
} Order;

typedef struct {
    int count;
    Order items[MAX_ORDERS];
} Orders;

void add_order(Orders *out, int good, int price, int qty);
void add_ioc_order(Orders *out, int good, int price, int qty);

/* Implemented by you. */
void trader_init(void);
void trader_run(const State *s, Orders *out);

#endif
