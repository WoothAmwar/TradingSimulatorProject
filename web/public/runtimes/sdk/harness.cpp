// Bridges the browser runtime and the user's Trader class (compiled as one translation unit with
// user_trader.cpp). Parses the flat state text and returns "price qty" lines.
#include <cstdio>
#include <sstream>
#include <string>

#include "trader.hpp"
#include "user_trader.cpp"

#define EXPORT(name) __attribute__((export_name(name)))

namespace {
constexpr int kInputCapacity = 1 << 20;
char in_buf[kInputCapacity];
std::string out_buf;
Trader* trader = nullptr;
// "Best time" rounds send every tick's price once, on the first tick; bots see it every tick.
std::vector<int> price_cache;
// Every earlier tick's price. Each state sends only the ones this bot hasn't had yet.
std::vector<double> history_cache;

// Reads "<tag> n price qty price qty ..." into items.
template <typename T>
void read_pairs(std::istringstream& in, std::vector<T>& items) {
    std::string tag;
    int n = 0;
    in >> tag >> n;
    items.resize(n > 0 ? n : 0);
    for (auto& item : items) in >> item.price >> item.qty;
}

State parse_state(const char* text) {
    std::istringstream in(text);
    State s;
    std::string tag;
    in >> tag >> s.tick >> s.cash >> s.position >> s.limit;
    read_pairs(in, s.bids);
    read_pairs(in, s.asks);
    read_pairs(in, s.trades);
    in >> std::ws;
    if (in.peek() == 'P') {
        int n = 0;
        in >> tag >> n;
        price_cache.resize(n > 0 ? n : 0);
        for (auto& p : price_cache) in >> p;
        in >> std::ws;
    }
    if (in.peek() == 'H') {  // "H start n p1 p2 ...": the history from index start on
        long long start = 0, n = 0;
        in >> tag >> start >> n;
        if (start < 0 || start > (long long)history_cache.size()) start = history_cache.size();
        history_cache.resize(start + (n > 0 ? n : 0));
        for (auto k = start; k < (long long)history_cache.size(); k++) in >> history_cache[k];
        in >> std::ws;
    }
    int lowest = -s.limit;  // the fewest units you may hold
    if (in.peek() == 'M') in >> tag >> lowest;
    s.prices = price_cache;
    s.history = history_cache;
    s.best_bid = s.bids.empty() ? 0 : s.bids[0].price;
    s.best_ask = s.asks.empty() ? 0 : s.asks[0].price;
    s.can_buy = s.limit > s.position ? s.limit - s.position : 0;
    s.can_sell = s.position > lowest ? s.position - lowest : 0;
    if (!s.bids.empty() && !s.asks.empty()) {
        s.price = (s.bids[0].price + s.asks[0].price) / 2.0;
    } else if (!s.bids.empty()) {
        s.price = s.bids[0].price;
    } else if (!s.asks.empty()) {
        s.price = s.asks[0].price;
    }
    return s;
}
}  // namespace

extern "C" {
EXPORT("bot_input") char* bot_input() { return in_buf; }
EXPORT("bot_input_capacity") int bot_input_capacity() { return kInputCapacity - 1; }

EXPORT("bot_init") void bot_init() {
    trader = new Trader();
    std::cout.flush();
}

EXPORT("bot_tick") const char* bot_tick(int len) {
    in_buf[len < kInputCapacity ? len : kInputCapacity - 1] = '\0';
    State state = parse_state(in_buf);
    std::vector<Order> orders = trader->run(state);
    std::cout.flush();
    std::cerr.flush();
    std::ostringstream out;
    for (const auto& o : orders) {
        if (o.qty != 0) out << o.price << ' ' << o.qty << '\n';
    }
    out_buf = out.str();
    return out_buf.c_str();
}
}
