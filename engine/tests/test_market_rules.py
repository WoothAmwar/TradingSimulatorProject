"""Market rules that matter once several groups trade together: price bands, keeping an
untouched order's place in line, and each bot seeing the book without its own orders."""

from market_core.driver import TickDriver
from market_core.exchange import ExchangeRules, TickLog
from market_core.protocol import bot_state
from market_core.types import BUY, SELL, CancelAll, NewOrder

RULES = ExchangeRules(goods=("X",), position_limits={"X": 50})
MAKER = "bot:mm:X"


def quotes(bid=99, ask=101, size=10):
    return [
        CancelAll(MAKER, "X"),
        NewOrder(MAKER, "X", BUY, bid, size),
        NewOrder(MAKER, "X", SELL, ask, size),
    ]


def driver():
    d = TickDriver(RULES)
    d.open_tick(0, quotes(bid=9_990, ask=10_010))
    return d


def resting(d, owner):
    return [(o.price, o.qty * o.side) for o in d.exchange.open_orders(owner)]


# Price bands ---------------------------------------------------------------------------------


def test_far_buys_and_sells_move_to_the_band_edge():
    for side, price, edge in ((BUY, 10_000_000, 10_100), (SELL, 1, 9_900)):
        d = driver()  # middle price 10_000, so the band is 9_900 .. 10_100
        assert d.exchange.bands["X"] == (9_900, 10_100)
        log = d.close_tick({"a": [NewOrder("a", "X", side, price, 15)]}, [])
        # Takes the maker's 10 units at its price, then rests the rest at the band's edge.
        assert [(f.price, f.qty) for f in log.fills] == [(10_010 if side == BUY else 9_990, 10)]
        assert resting(d, "a") == [(edge, 5 * side)]


def test_passive_orders_and_bots_ignore_the_band():
    d = driver()
    log = d.close_tick(
        {"a": [NewOrder("a", "X", BUY, 5_000, 1), NewOrder("a", "X", SELL, 20_000, 1)]},
        [NewOrder("bot:noise", "X", BUY, 50_000, 2, "IOC")],
    )
    assert resting(d, "a") == [(5_000, 1), (20_000, -1)]
    assert [f.price for f in log.fills] == [10_010]  # the bot reached past the band


def test_band_always_includes_the_best_quotes():
    d = TickDriver(RULES)
    d.open_tick(0, quotes(bid=9_000, ask=11_000))  # spread wider than 1% either side
    assert d.exchange.bands["X"] == (9_000, 11_000)


# Place in line -------------------------------------------------------------------------------


def replace_orders(owner, *orders):
    return [CancelAll(owner), *(NewOrder(owner, "X", side, px, q) for side, px, q in orders)]


def test_unchanged_order_keeps_its_place_in_line():
    d = driver()
    d.close_tick({"a": replace_orders("a", (BUY, 9_995, 5))}, [])
    d.open_tick(1, quotes(bid=9_990, ask=10_010))
    d.close_tick({"b": replace_orders("b", (BUY, 9_995, 5))}, [])
    [a_order] = d.exchange.open_orders("a")

    d.open_tick(2, quotes(bid=9_990, ask=10_010))
    # b happens to go first this tick; a re-sends the same order and keeps its place.
    log = d.close_tick(
        {"a": replace_orders("a", (BUY, 9_995, 5)), "b": replace_orders("b", (BUY, 9_995, 5))},
        [NewOrder("bot:noise", "X", SELL, 9_995, 5, "IOC")],
    )
    assert d.exchange.open_orders("a") == [] and a_order.qty == 0
    assert [(f.buyer, f.maker_order_id) for f in log.fills] == [("a", a_order.id)]


def test_changed_or_dropped_orders_go_to_the_back_or_away():
    d = driver()
    d.close_tick({"a": replace_orders("a", (BUY, 9_995, 5), (SELL, 10_005, 5))}, [])
    first = {o.price: o.id for o in d.exchange.open_orders("a")}
    d.open_tick(1, quotes(bid=9_990, ask=10_010))
    d.close_tick({"a": replace_orders("a", (BUY, 9_995, 4))}, [])  # smaller, and no sell
    [order] = d.exchange.open_orders("a")
    assert (order.price, order.qty) == (9_995, 4) and order.id != first[9_995]


def test_partly_filled_order_resent_at_full_size_is_a_new_order():
    d = driver()
    d.close_tick({"a": replace_orders("a", (BUY, 9_995, 5))}, [])
    d.open_tick(1, quotes(bid=9_990, ask=10_010))
    d.close_tick({}, [NewOrder("bot:noise", "X", SELL, 9_995, 2, "IOC")])
    [left] = d.exchange.open_orders("a")
    assert left.qty == 3
    d.open_tick(2, quotes(bid=9_990, ask=10_010))
    d.close_tick({"a": replace_orders("a", (BUY, 9_995, 5))}, [])
    [order] = d.exchange.open_orders("a")
    assert order.qty == 5 and order.id != left.id
    assert d.exchange.account("a").position["X"] == 2


def test_kept_orders_are_not_new_orders_for_the_rate_limit():
    d = TickDriver(ExchangeRules(goods=("X",), position_limits={"X": 50}, max_orders_per_tick=2))
    d.open_tick(0, quotes(bid=9_990, ask=10_010))
    two = ((BUY, 9_994, 1), (BUY, 9_993, 1))
    d.close_tick({"a": replace_orders("a", *two)}, [])
    d.open_tick(1, quotes(bid=9_990, ask=10_010))
    log = d.close_tick({"a": replace_orders("a", *two, (BUY, 9_992, 1))}, [])
    assert log.rejects == [] and len(d.exchange.open_orders("a")) == 3


def test_clamped_order_sent_again_is_kept():
    d = TickDriver(RULES)
    d.open_tick(0, [NewOrder(MAKER, "X", SELL, 10_000, 10)])  # no bids: a sell at 1 rests
    log = TickLog()
    d.exchange.apply_batch(0, replace_orders("a", (SELL, 1, 1), (SELL, 1, 1)), log)
    first = d.exchange.open_orders("a")
    assert [o.price for o in first] == [9_900, 9_900]
    d.exchange.apply_batch(0, replace_orders("a", (SELL, 1, 1), (SELL, 1, 1)), log)
    assert d.exchange.open_orders("a") == first and log.rejects == []


# What each bot sees --------------------------------------------------------------------------


def test_bots_see_the_book_without_their_own_orders():
    d = driver()
    d.close_tick(
        {
            "a": replace_orders("a", (BUY, 9_995, 5), (BUY, 9_990, 3)),
            "b": replace_orders("b", (SELL, 10_005, 2)),
        },
        [],
    )
    d.open_tick(1, [])
    a, b = bot_state(d, "a")["order_depths"]["X"], bot_state(d, "b")["order_depths"]["X"]
    assert a == {"bids": [[9_990, 10]], "asks": [[10_005, 2], [10_010, 10]]}
    assert b == {"bids": [[9_995, 5], [9_990, 13]], "asks": [[10_010, 10]]}
    assert [o["price"] for o in bot_state(d, "a")["open_orders"]] == [9_995, 9_990]
    assert d.public_state()["order_depths"]["X"]["bids"] == [[9_995, 5], [9_990, 13]]
