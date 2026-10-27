// ACM Trading Simulator — C++ bot API.
//
// Define `class Trader` with `std::vector<Order> run(const State& s)`. One instance lives for the
// whole session. The orders you return replace all of your resting orders.
// qty > 0 buys, qty < 0 sells. std::cout output appears in the console.
#pragma once

#include <iostream>
#include <string>
#include <vector>

struct Level {
    int price;
    int qty;
};

struct Trade {
    int price;
    int qty;
    int side;  // +1: the buyer crossed the spread, -1: the seller did
};

struct Good {
    std::string name;
    int position = 0;
    int limit = 0;              // |position| may never exceed this
    std::vector<Level> bids;    // best (highest) first
    std::vector<Level> asks;    // best (lowest) first
    std::vector<Trade> trades;  // market trades since the last tick
};

struct State {
    int tick = 0;
    long long cash = 0;
    std::vector<Good> goods;
};

struct Order {
    std::string good;
    int price;
    int qty;
    bool ioc = false;  // immediate-or-cancel instead of resting
};
