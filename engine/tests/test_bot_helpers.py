"""What bots get besides the raw book: best_bid/best_ask, can_buy/can_sell, the price at every
earlier tick (state.history: prices.csv first in live rounds) and price_stats()."""

import csv
import io
import statistics
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_sandbox import STATE, needs_python, run, shared
from test_server import ADMIN, LOBBY, FakeBot, FakeVerifier, make_store, select, wait_for

from market_core.backtest import Backtest
from market_core.config import STABLE, LobbyConfig
from market_core.dataset import build_dataset, read_events
from market_core.series import SeriesBacktest
from server import bots
from server.app import create_app
from server.sandbox import PythonBot, state_to_text
from server.settings import Settings

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bot_sdk"))
import bot_runner  # noqa: E402
from trader_sdk import TradingState, price_stats  # noqa: E402

SEES_HISTORY = """
class Trader:
    def run(self, state):
        self.seen = state.history
        return []
"""


def wire(**changes) -> dict:
    """A wire state for one good, X."""
    state = {
        "tick": 5,
        "goods": ["X"],
        "limits": {"X": 10},
        "order_depths": {"X": {"bids": [[99, 2]], "asks": []}},
        "market_trades": {"X": []},
        "position": {"X": 4},
        "cash": 0,
        "own_trades": [],
    }
    return {**state, **changes}


def mid_prices(csv_text: str) -> list[float]:
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    assert all(r["mid_price"] for r in rows)  # no empty book, so prices.csv has every price
    return [float(r["mid_price"]) for r in rows]


def test_price_stats():
    assert price_stats([]) == (None, None)
    assert price_stats([1, 2, 3, 4]) == (2.5, 1.25**0.5)
    assert price_stats((1, 2, 3, 4), last=2) == (3.5, 0.5)
    assert price_stats([1, 2, 3, 4], last=0) == price_stats([1, 2, 3, 4])
    assert price_stats([10_000.5] * 3) == (10_000.5, 0.0)
    prices = [10_000 + (i * 7919 % 13) * 0.5 for i in range(20_000)]
    average, stdev = price_stats(prices)
    assert average == pytest.approx(statistics.fmean(prices), abs=1e-9)
    assert stdev == pytest.approx(statistics.pstdev(prices), abs=1e-9)


def test_state_shortcuts():
    s = TradingState(wire())
    assert (s.best_bid, s.best_ask, s.can_buy, s.can_sell, s.history) == (99, None, 6, 14, ())
    assert (TradingState(wire(position={"X": -10})).can_buy, TradingState(wire()).price) == (20, 99)
    assert TradingState(wire(position={"X": -10})).can_sell == 0
    # Best-time rounds don't let you owe units.
    s = TradingState(wire(limits={"X": 1}, min_positions={"X": 0}, position={"X": 1}))
    assert (s.can_buy, s.can_sell) == (0, 1)


def test_bot_keeps_the_history_it_is_sent():
    bot = bot_runner.Bot(SEES_HISTORY)
    bot.tick(wire(history_start=0, history={"X": [1, 2, 3]}))
    assert bot.trader.seen == (1, 2, 3)
    bot.tick(wire(history_start=3, history={"X": [4]}))
    bot.tick(wire())  # a state without new prices
    assert bot.trader.seen == (1, 2, 3, 4)
    bot.tick(wire(history_start=0, history={"X": [9]}))  # sent again from the start
    assert bot.trader.seen == (9,)


def test_backtest_history_is_prices_csv_up_to_now(tmp_path):
    config = LobbyConfig(goods=(STABLE,), dataset_ticks=200)
    manifest = build_dataset(config, 42, tmp_path)
    mids = mid_prices((tmp_path / "prices.csv").read_text())
    bt = Backtest(manifest, read_events(tmp_path / "events.jsonl.gz"))
    bot = bot_runner.Bot(SEES_HISTORY)
    for t in range(200):
        state = bt.open_next()
        bot.tick(state)
        assert bot.trader.seen == tuple(mids[:t])  # no peeking at this tick or later ones
        assert len(state["history"]["STABLE"]) == (1 if t else 0)
        bt.close(None)  # trading nothing keeps the market identical to prices.csv
    assert bt.open_next() is None


def test_series_history_and_floor():
    manifest = {
        "kind": "series",
        "rules": {"goods": ["X"], "position_limits": {"X": 1}, "min_positions": {"X": 0}},
    }
    bt = SeriesBacktest(manifest, [{"t": t, "prices": {"X": p}} for t, p in enumerate([5, 7, 6])])
    bot = bot_runner.Bot(SEES_HISTORY)
    seen = []
    while (state := bt.open_next()) is not None:
        bot.tick(state)
        seen.append(bot.trader.seen)
        assert TradingState(state).can_sell == 0  # owns nothing, and may not owe
        bt.close(None)
    assert seen == [(), (5,), (5, 7)]


def test_c_text_protocol_carries_history_and_floor():
    text = state_to_text({**STATE, "history_start": 3, "history": {"STABLE": [10001, 10000.5]}})
    assert text.endswith("X 1 10001 3\nH 3 2 10001 10000.5\n")
    assert state_to_text({**STATE, "min_positions": {"STABLE": 0}}).endswith("\nM 0\n")


class RecordingBot(FakeBot):
    def __init__(self, *args) -> None:
        super().__init__(*args)
        self.states: list[dict] = []

    async def tick(self, state: dict):
        self.states.append(state)
        return await super().tick(state)


def test_live_bots_get_prices_csv_then_each_new_price(monkeypatch):
    monkeypatch.setattr(bots, "SYNC_EVERY_S", 0.1)
    monkeypatch.setattr(bots, "RESTART_DELAYS_S", (0.2,))
    store = make_store()
    store.lobbies[LOBBY].public_config["live_ticks"] = 400
    select(store, "g1", "s1", "quiet")
    settings = Settings("http://supabase.test", "secret", (), "i1", lease_ttl_seconds=30)
    RecordingBot.made.clear()
    with TestClient(create_app(store, FakeVerifier(), settings, RecordingBot)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        files, manifest = store.datasets[LOBBY]
        k = manifest["ticks"]
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        runner = client.app.state.manager.runners[LOBBY]
        g1 = runner.bots.group("g1")
        wait_for(lambda: g1.answered >= 3)

        first, second = g1.bot.states[:2]
        assert first["tick"] == k and first["history_start"] == 0
        assert first["history"]["STABLE"] == mid_prices(files["prices.csv"].decode())
        assert second["history_start"] == k
        assert second["history"]["STABLE"] == [runner.prices.prices["STABLE"][k]]

        # A bot that starts later (here: after a crash) gets every earlier price at once.
        select(store, "g2", "s2", "crash")
        g2 = runner.bots.group("g2")
        wait_for(lambda: g2.crashes == 1)
        wait_for(lambda: g2.status == "running" and g2.answered > 0)
        restarted = g2.bot.states[0]
        assert restarted["history_start"] == 0
        assert len(restarted["history"]["STABLE"]) == restarted["tick"]
        client.post(f"/admin/lobbies/{LOBBY}/stop", headers=ADMIN)


@needs_python
def test_sandboxed_python_bot_uses_the_helpers():
    source = """
from trader_sdk import buy, price_stats

class Trader:
    def run(self, state):
        average, stdev = price_stats(state.history, last=2)
        print(len(state.history), average, stdev, state.best_bid, state.can_buy)
        return [buy(state.best_bid, state.can_buy)]
"""

    async def scenario():
        bot = PythonBot(shared(), source)
        await bot.start()
        first = await bot.tick({**STATE, "history_start": 0, "history": {"STABLE": [1, 2, 3]}})
        second = await bot.tick({**STATE, "history_start": 3, "history": {"STABLE": [5]}})
        assert first.logs == ["3 2.5 0.5 9998 46"]
        assert second.logs == ["4 4.0 1.0 9998 46"]
        assert second.response["orders"] == [{"good": "STABLE", "price": 9998, "qty": 46}]
        bot.close()

    run(scenario())


@needs_python
def test_sandboxed_python_bot_gets_a_history_bigger_than_its_pipe():
    """The first live state carries all of prices.csv: more than a pipe holds (64 KB on Linux)."""
    source = """
class Trader:
    def run(self, state):
        print(len(state.history), state.history[-1])
        return []
"""
    prices = [10_000 + i % 7 * 0.5 for i in range(30_000)]

    async def scenario():
        bot = PythonBot(shared(), source)
        await bot.start()
        reply = await bot.tick({**STATE, "history_start": 0, "history": {"STABLE": prices}})
        assert reply.logs == [f"30000 {prices[-1]}"]
        bot.close()

    run(scenario())
