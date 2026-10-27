from market_core.exchange import Exchange, ExchangeRules, TickLog
from market_core.types import BUY, SELL, CancelAll, NewOrder


def make(**kw):
    rules = ExchangeRules(goods=("X",), position_limits={"X": 10}, **kw)
    ex = Exchange(rules)
    return ex


def apply_all(ex, tick, actions):
    log = TickLog()
    ex.begin_tick(tick, log)
    for a in actions:
        ex.apply(tick, a, log)
    return log


def test_position_limit_counts_open_orders():
    ex = make()
    log = apply_all(
        ex,
        0,
        [
            NewOrder("g", "X", BUY, 100, 6),
            NewOrder("g", "X", BUY, 100, 5),  # 6 open + 5 > 10
            NewOrder("g", "X", SELL, 110, 10),  # sells are checked independently
            NewOrder("g", "X", SELL, 110, 11),
        ],
    )
    assert [r.reason for r in log.rejects] == ["position limit", "position limit"]


def test_bots_are_exempt_from_limits():
    ex = make()
    log = apply_all(ex, 0, [NewOrder("bot:mm:X", "X", BUY, 100, 500)])
    assert log.rejects == []


def test_rate_limit_resets_each_tick():
    ex = make(max_orders_per_tick=2)
    log = apply_all(ex, 0, [NewOrder("g", "X", BUY, 90 + i, 1, "IOC") for i in range(3)])
    assert [r.reason for r in log.rejects] == ["too many orders this tick"]
    assert apply_all(ex, 1, [NewOrder("g", "X", BUY, 95, 1, "IOC")]).rejects == []


def test_open_order_limit():
    ex = make(max_open_orders=2)
    log = apply_all(ex, 0, [NewOrder("g", "X", BUY, 90 + i, 1) for i in range(3)])
    assert [r.reason for r in log.rejects] == ["too many open orders"]
    log = apply_all(ex, 1, [CancelAll("g"), NewOrder("g", "X", BUY, 95, 1)])
    assert log.rejects == []


def test_validation():
    ex = make()
    log = apply_all(
        ex,
        0,
        [
            NewOrder("g", "Y", BUY, 100, 1),
            NewOrder("g", "X", BUY, 0, 1),
            NewOrder("g", "X", BUY, 100.5, 1),
            NewOrder("g", "X", BUY, 100, 0),
            NewOrder("g", "X", BUY, 100, 1, "FOK"),
        ],
    )
    assert [r.reason for r in log.rejects] == [
        "unknown good",
        "price out of range",
        "price must be an integer",
        "quantity must be a positive integer",
        "tif must be GTC or IOC",
    ]


def test_fees_apply_to_participants_only():
    ex = make(maker_fee=-1, taker_fee=2)
    apply_all(
        ex, 0, [NewOrder("bot:mm", "X", SELL, 100, 5), NewOrder("g", "X", BUY, 100, 5, "IOC")]
    )
    assert ex.account("g").cash == -500 - 10
    assert ex.account("bot:mm").cash == 500
    apply_all(ex, 1, [NewOrder("h", "X", SELL, 100, 3), NewOrder("bot:n", "X", BUY, 100, 3, "IOC")])
    assert ex.account("h").cash == 300 + 3  # maker rebate


def test_ttl_expiry():
    ex = make()
    apply_all(ex, 0, [NewOrder("bot:noise", "X", BUY, 99, 5, "GTC", ttl=2)])
    apply_all(ex, 1, [])
    assert ex.books["X"].best_bid() == 99
    log = apply_all(ex, 2, [])
    assert ex.books["X"].best_bid() is None
    assert [o.owner for o in log.cancelled] == ["bot:noise"]
