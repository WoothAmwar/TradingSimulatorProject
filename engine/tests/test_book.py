from hypothesis import given, settings
from hypothesis import strategies as st

from market_core.exchange import Exchange, ExchangeRules, TickLog
from market_core.types import BUY, SELL, Cancel, NewOrder

RULES = ExchangeRules(
    goods=("X",), position_limits={"X": 10_000}, max_orders_per_tick=10_000, max_open_orders=10_000
)


def run(actions):
    ex = Exchange(RULES)
    log = TickLog()
    ex.begin_tick(0, log)
    for a in actions:
        ex.apply(0, a, log)
    return ex, log


def test_price_time_priority_and_maker_price():
    ex, log = run(
        [
            NewOrder("a", "X", SELL, 101, 5),
            NewOrder("b", "X", SELL, 100, 5),
            NewOrder("c", "X", SELL, 100, 5),
            NewOrder("d", "X", BUY, 101, 12, "IOC"),
        ]
    )
    assert [(f.seller, f.price, f.qty) for f in log.fills] == [
        ("b", 100, 5),
        ("c", 100, 5),
        ("a", 101, 2),
    ]
    assert ex.books["X"].depth() == ([], [[101, 3]])
    assert ex.account("d").position["X"] == 12
    assert ex.account("d").cash == -(100 * 10 + 101 * 2)


def test_ioc_remainder_is_discarded_and_gtc_rests():
    ex, _ = run([NewOrder("a", "X", SELL, 100, 2), NewOrder("b", "X", BUY, 100, 5, "IOC")])
    assert ex.books["X"].best_bid() is None
    ex, _ = run([NewOrder("a", "X", SELL, 100, 2), NewOrder("b", "X", BUY, 100, 5, "GTC")])
    assert ex.books["X"].depth() == ([[100, 3]], [])


def test_self_trade_cancels_resting_order():
    ex, log = run(
        [
            NewOrder("a", "X", SELL, 100, 5),
            NewOrder("b", "X", SELL, 101, 5),
            NewOrder("a", "X", BUY, 101, 5, "IOC"),
        ]
    )
    assert [f.seller for f in log.fills] == ["b"]
    assert [o.owner for o in log.cancelled] == ["a"]
    assert ex.open_orders("a") == []


def test_cancel_only_own_orders():
    ex, log = run([NewOrder("a", "X", BUY, 99, 5), Cancel("b", 1), Cancel("a", 1)])
    assert [r.reason for r in log.rejects] == ["unknown order"]
    assert ex.books["X"].best_bid() is None


order_strategy = st.builds(
    NewOrder,
    owner=st.sampled_from(["a", "b", "c", "bot:x"]),
    good=st.just("X"),
    side=st.sampled_from([BUY, SELL]),
    price=st.integers(95, 105),
    qty=st.integers(1, 20),
    tif=st.sampled_from(["GTC", "IOC"]),
)


@settings(max_examples=300, deadline=None)
@given(st.lists(order_strategy, max_size=80))
def test_book_never_crossed_and_trades_conserve(actions):
    ex = Exchange(RULES)
    log = TickLog()
    ex.begin_tick(0, log)
    for a in actions:
        ex.apply(0, a, log)
        bid, ask = ex.books["X"].best_bid(), ex.books["X"].best_ask()
        assert bid is None or ask is None or bid < ask
    assert sum(acct.position.get("X", 0) for acct in ex.accounts.values()) == 0
    assert sum(acct.cash for acct in ex.accounts.values()) == 0
    resting = sum(q for _, q in ex.books["X"].depth()[0] + ex.books["X"].depth()[1])
    assert resting == sum(o.qty for owner in "abc" for o in ex.open_orders(owner)) + sum(
        o.qty for o in ex.open_orders("bot:x")
    )
