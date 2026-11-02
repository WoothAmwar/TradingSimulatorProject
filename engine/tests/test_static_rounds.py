"""Static rounds: deterministic data, price-series rules and scoring."""

import json

import pytest

from market_core.backtest import Backtest, make_backtest
from market_core.config import default_lobby_config
from market_core.dataset import build_dataset, read_events
from market_core.series import SeriesBacktest
from market_core.static_rounds import build_static_dataset


def max_profit(prices: list[int]) -> int:
    """The reference LeetCode 121 solution the round is designed around."""
    b = 0
    s = 0
    profit = 0
    for idx, curr_p in enumerate(prices):
        if curr_p > prices[s]:
            s = idx
            profit = max(profit, curr_p - prices[b])
        if curr_p < prices[b]:
            b = idx
            s = idx
    return profit


def best_ticks(prices: list[int]) -> tuple[int, int]:
    """The same scan, keeping the (buy, sell) ticks of the best pair."""
    low, buy, sell, best = 0, 0, 0, 0
    for i, p in enumerate(prices):
        if p < prices[low]:
            low = i
        elif p - prices[low] > best:
            best, buy, sell = p - prices[low], low, i
    return buy, sell


def load(out):
    manifest = json.loads((out / "manifest.json").read_text())
    return manifest, list(read_events(out / "events.jsonl.gz"))


@pytest.mark.parametrize("preset", ["BEST_TIME", "FLAT_MEAN"])
def test_static_rounds_are_deterministic(tmp_path, preset):
    a, preview_a = build_static_dataset(preset, 200, 42, tmp_path / "a")
    b, preview_b = build_static_dataset(preset, 200, 42, tmp_path / "b")
    c, _ = build_static_dataset(preset, 200, 43, tmp_path / "c")
    assert a == b and preview_a == preview_b
    assert a["files"] != c["files"]
    assert a["ticks"] == 200 and len(load(tmp_path / "a")[1]) == 200


def test_unknown_preset_and_bad_length(tmp_path):
    with pytest.raises(ValueError):
        build_static_dataset("NOPE", 100, 1, tmp_path)
    with pytest.raises(ValueError):
        build_static_dataset("BEST_TIME", 5, 1, tmp_path)


def test_best_optimal_trades_score_exactly_max_profit(tmp_path):
    manifest, preview = build_static_dataset("BEST_TIME", 500, 7, tmp_path)
    _, events = load(tmp_path)
    prices = [e["prices"]["STOCK"] for e in events]
    assert manifest["kind"] == "series" and min(prices) >= 1
    assert preview["STOCK"][:3] == [[0, prices[0]], [1, prices[1]], [2, prices[2]]]
    buy, sell = best_ticks(prices)

    def trader(state):
        assert state["prices"]["STOCK"] == tuple(prices)  # the whole path, on every tick
        price = state["order_depths"]["STOCK"]["asks"][0][0]
        if state["tick"] == buy:
            return {"orders": [{"good": "STOCK", "price": price, "qty": 1}]}
        if state["tick"] == sell:
            return {"orders": [{"good": "STOCK", "price": price, "qty": -1}]}
        return None

    bt = make_backtest(manifest, events)
    assert isinstance(bt, SeriesBacktest)
    summaries = bt.run(trader)
    assert max_profit(prices) > 0
    assert bt.score() == max_profit(prices) == prices[sell] - prices[buy]
    assert sum(len(s["fills"]) for s in summaries) == 2
    assert not any(s["rejects"] for s in summaries)


def test_series_rules():
    manifest = {
        "kind": "series",
        "rules": {
            "goods": ["STOCK"],
            "position_limits": {"STOCK": 1},
            "min_positions": {"STOCK": 0},
            "max_trades": 2,
        },
    }
    events = [{"t": t, "prices": {"STOCK": p}} for t, p in enumerate([10, 8, 12, 15])]
    bt = SeriesBacktest(manifest, events)

    def orders(*pairs):
        return {"orders": [{"good": "STOCK", "price": p, "qty": q} for p, q in pairs]}

    state = bt.open_next()
    assert state["order_depths"]["STOCK"] == {"bids": [[10, 1]], "asks": [[10, 1]]}
    assert state["prices"] == {"STOCK": (10, 8, 12, 15)}
    r = bt.close(orders((10, -1), (9, 1)))
    assert r["rejects"] == ["short selling is not allowed", "buy price is below this tick's price"]

    bt.open_next()
    r = bt.close(orders((9, 1), (8, 1)))  # marketable above the price, fills at 8
    assert r["fills"] == [{"good": "STOCK", "price": 8, "qty": 1}]
    assert r["rejects"] == ["position limit"] and r["cash"] == -8

    state = bt.open_next()
    assert state["own_trades"] == [{"good": "STOCK", "price": 8, "qty": 1, "maker": False}]
    r = bt.close(orders((12, -1)))
    assert r["fills"][0]["qty"] == -1 and r["position"] == {"STOCK": 0}

    bt.open_next()
    r = bt.close(orders((15, 1)))
    assert r["rejects"] == ["no trades left this round"]
    assert bt.open_next() is None
    assert bt.score() == 4


def test_flat_mean_market_maker_profits_at_the_mean_mark(tmp_path):
    manifest, preview = build_static_dataset("FLAT_MEAN", 400, 11, tmp_path)
    _, events = load(tmp_path)
    mean = manifest["marks"]["FLAT"]
    assert manifest["kind"] == "orderbook" and 800 <= mean <= 1200
    assert all(abs(mid - mean) <= 4 for _, mid in preview["FLAT"])

    def trader(state):
        position, limit = state["position"]["FLAT"], state["limits"]["FLAT"]
        orders = []
        if limit - position > 0:
            orders.append({"good": "FLAT", "price": mean - 1, "qty": min(5, limit - position)})
        if limit + position > 0:
            orders.append({"good": "FLAT", "price": mean + 1, "qty": -min(5, limit + position)})
        return {"cancel_all": True, "orders": orders}

    bt = make_backtest(manifest, events)
    assert isinstance(bt, Backtest)
    bt.run(trader)
    acct = bt.driver.exchange.account("you")
    assert bt.score() == acct.cash + acct.position.get("FLAT", 0) * mean
    assert bt.score() > 0


def test_live_datasets_still_replay_with_the_order_book(tmp_path):
    manifest = build_dataset(default_lobby_config(), 5, tmp_path, ticks=20)
    events = list(read_events(tmp_path / "events.jsonl.gz"))
    bt = make_backtest(manifest, events)
    assert isinstance(bt, Backtest) and bt.goods == ["STABLE", "VOLATILE"]
    summaries = bt.run(lambda state: None)
    assert bt.score() == summaries[-1]["pnl"] == 0
