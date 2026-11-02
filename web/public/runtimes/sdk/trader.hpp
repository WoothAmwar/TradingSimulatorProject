// ACM Trading Simulator: C++ bot API.
//
// Define `class Trader` with `std::vector<Order> run(const State& s)`. run() is called every tick:
// return orders made with buy() and sell(), or {} to do nothing. They replace last tick's orders.
// One Trader lives for the whole session, so members keep their values between ticks.
// std::cout output appears in the console. Every round trades a single good.
#pragma once

#include <iostream>
#include <string>
#include <vector>

struct Level {
    int price;
    int qty;
};  // an offer: qty units at price

struct Trade {
    int price;
    int qty;
};

struct State {
    int tick = 0;               // tick number: 0, 1, 2, ...
    double price = 0;           // current price: halfway between the best bid and ask
    std::vector<Level> bids;    // offers to buy, highest price first
    std::vector<Level> asks;    // offers to sell, lowest price first
    std::vector<Trade> trades;  // everyone's trades since the last tick
    int position = 0;           // units you own (below 0: you owe units)
    int limit = 0;              // the most units you may own, or owe
    long long cash = 0;         // money from selling minus money spent buying
    std::vector<int> prices;    // "best time" rounds: every tick's price, past and future
};

struct Order {
    int price;
    int qty;  // > 0 buys, < 0 sells
};

// Buy qty units, paying at most price each.
inline Order buy(int price, int qty = 1) { return {price, qty < 0 ? -qty : qty}; }
// Sell qty units, getting at least price each.
inline Order sell(int price, int qty = 1) { return {price, qty < 0 ? qty : -qty}; }
