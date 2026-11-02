/* ACM Trading Simulator: C bot API.
 *
 * Write trader_init() and trader_run(). trader_run() is called every tick: look at the state and add
 * orders with buy() and sell(), or add none to do nothing. The orders you add replace last tick's.
 * printf() output appears in the console. Every round trades a single good.
 */
#ifndef TRADER_H
#define TRADER_H

#define MAX_LEVELS 64
#define MAX_TRADES 128
#define MAX_ORDERS 64
#define MAX_PRICES 20000

typedef struct {
    int price;
    int qty;
} Level; /* an offer: qty units at price */

typedef Level Trade; /* a trade: qty units changed hands at price */

typedef struct {
    int tick;                 /* tick number: 0, 1, 2, ... */
    double price;             /* current price: halfway between the best bid and ask */
    int num_bids, num_asks, num_trades;
    Level bids[MAX_LEVELS];   /* offers to buy, highest price first */
    Level asks[MAX_LEVELS];   /* offers to sell, lowest price first */
    Trade trades[MAX_TRADES]; /* everyone's trades since the last tick */
    int position;             /* units you own (below 0: you owe units) */
    int limit;                /* the most units you may own, or owe */
    long long cash;           /* money from selling minus money spent buying */
    const int *prices;        /* "best time" rounds: every tick's price, past and future */
    int num_prices;
} State;

typedef struct {
    int price;
    int qty; /* > 0 buys, < 0 sells */
} Order;

typedef struct {
    int count;
    Order items[MAX_ORDERS];
} Orders;

void buy(Orders *out, int price, int qty);  /* buy qty units, paying at most price each */
void sell(Orders *out, int price, int qty); /* sell qty units, getting at least price each */

/* Written by you. */
void trader_init(void);
void trader_run(const State *s, Orders *out);

#endif
