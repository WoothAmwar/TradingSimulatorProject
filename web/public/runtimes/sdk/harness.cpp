// Bridges the browser runtime and the user's Trader class (compiled as one translation unit with
// user_trader.cpp). Parses the flat state text and returns "good price qty ioc" lines.
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

void read_levels(std::istringstream& in, std::vector<Level>& levels) {
    std::string tag;
    int n = 0;
    in >> tag >> n;
    levels.resize(n > 0 ? n : 0);
    for (auto& level : levels) in >> level.price >> level.qty;
}

State parse_state(const char* text) {
    std::istringstream in(text);
    State s;
    std::string tag;
    int goods = 0;
    in >> tag >> s.tick >> s.cash >> goods;
    s.goods.resize(goods > 0 ? goods : 0);
    for (auto& g : s.goods) {
        in >> tag >> g.name >> g.position >> g.limit;
        read_levels(in, g.bids);
        read_levels(in, g.asks);
        int n = 0;
        in >> tag >> n;
        g.trades.resize(n > 0 ? n : 0);
        for (auto& t : g.trades) in >> t.price >> t.qty >> t.side;
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
        for (size_t i = 0; i < state.goods.size(); i++) {
            if (state.goods[i].name == o.good && o.qty != 0) {
                out << i << ' ' << o.price << ' ' << o.qty << ' ' << (o.ioc ? 1 : 0) << '\n';
                break;
            }
        }
    }
    out_buf = out.str();
    return out_buf.c_str();
}
}
