from market_core.types import BUY, SELL, Fill
from server.trades import TRADE_HISTORY, TradeLog

NAMES = {"a": "Alpha", "b": "Beta"}


def fill(price, qty, buyer, seller, aggressor):
    return Fill(7, "X", price, qty, buyer, seller, aggressor, 1, 2)


def test_rows_show_groups_by_name_and_computer_traders_as_none():
    log = TradeLog()
    rows = log.add_fills(
        7,
        [
            fill(101, 3, "a", "bot:mm:X", BUY),
            fill(99, 2, "bot:noise", "b", BUY),
            fill(100, 4, "a", "b", SELL),
            fill(100, 1, "bot:mm:X", "bot:noise", SELL),  # no group: not a group trade
        ],
        {"X": 100.0},
        NAMES,
    )
    assert [(r["buyer"], r["seller"]) for r in rows] == [
        ({"id": "a", "name": "Alpha"}, None),
        (None, {"id": "b", "name": "Beta"}),
        ({"id": "a", "name": "Alpha"}, {"id": "b", "name": "Beta"}),
    ]
    assert rows[0] == {
        **rows[0],
        "tick": 7,
        "price": 101,
        "qty": 3,
        "aggressor": BUY,
        "mid": 100.0,
        "good": "X",
    }


def test_totals_per_group():
    log = TradeLog()
    log.add_fills(
        7,
        [fill(101, 3, "a", "bot:mm:X", BUY), fill(99, 2, "bot:noise", "b", BUY)],
        {"X": 100.0},
        NAMES,
    )
    log.add_fills(8, [fill(102, 4, "a", "b", SELL)], {"X": 101.5}, NAMES)
    stats = log.snapshot()["group_stats"]
    assert stats["a"] == {
        "name": "Alpha",
        "trades": 2,
        "bought": 7,
        "sold": 0,
        "spent": 303 + 408,
        "received": 0,
        "edge": -3.0 + -2.0,  # paid 1 over for 3 units, then 0.5 over for 4
        "with_groups": 1,
        "took": 1,
    }
    assert stats["b"]["sold"] == 6 and stats["b"]["took"] == 1  # sold into a's bid at tick 8
    assert stats["b"]["edge"] == -2.0 + 2.0


def test_recent_trades_are_capped_but_totals_cover_the_round():
    log = TradeLog()
    for t in range(TRADE_HISTORY + 5):
        log.add_fills(t, [fill(100, 1, "a", "bot:mm:X", BUY)], {}, NAMES)
    snap = log.snapshot()
    assert len(snap["group_trades"]) == TRADE_HISTORY
    assert snap["group_trades"][0]["tick"] == 5
    assert snap["group_stats"]["a"]["trades"] == TRADE_HISTORY + 5
    assert snap["group_stats"]["a"]["edge"] == 0  # no market price: no edge counted


def test_from_database_rows_matches_live_log():
    live = TradeLog()
    live.add_fills(
        7, [fill(101, 3, "a", "bot:mm:X", BUY), fill(100, 4, "a", "b", SELL)], {"X": 100.0}, NAMES
    )
    rows = [
        {
            "tick": 7,
            "good": "X",
            "price": 101,
            "qty": 3,
            "aggressor": BUY,
            "buyer_group": "a",
            "seller_group": None,
        },
        {
            "tick": 7,
            "good": "X",
            "price": 100,
            "qty": 4,
            "aggressor": SELL,
            "buyer_group": "a",
            "seller_group": "b",
        },
    ]
    assert TradeLog.from_rows(rows, {(7, "X"): 100.0}, NAMES).snapshot() == live.snapshot()
