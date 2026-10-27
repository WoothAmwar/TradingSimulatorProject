"""The properties the game depends on: same seed -> same market, and the dataset is an exact
prefix of the live lobby that a backtest reproduces tick for tick."""

import hashlib
import json

import pytest

from market_core.backtest import Backtest
from market_core.config import LobbyConfig, default_lobby_config
from market_core.dataset import build_dataset, read_events
from market_core.protocol import bot_state, parse_bot_response
from market_core.simulator import MarketSimulator
from market_core.types import action_to_dict

SEED = 0xC0FFEE_1234_5678_9ABC_DEF0
CONFIG = LobbyConfig(goods=default_lobby_config().goods, dataset_ticks=400)


def event_hash(seed: int, ticks: int) -> str:
    sim = MarketSimulator(CONFIG, seed)
    h = hashlib.sha256()
    for _ in range(ticks):
        sim.open_tick()
        assert sim.current is not None
        h.update(
            json.dumps([action_to_dict(a) for a in sim.current.pre + sim.current.post]).encode()
        )
        h.update(json.dumps(sim.current.fair_values).encode())
        sim.close_tick()
    return h.hexdigest()


def test_same_seed_same_market():
    assert event_hash(SEED, 300) == event_hash(SEED, 300)
    assert event_hash(SEED, 300) != event_hash(SEED + 1, 300)


def test_dataset_is_byte_reproducible(tmp_path):
    a = build_dataset(CONFIG, SEED, tmp_path / "a")
    b = build_dataset(CONFIG, SEED, tmp_path / "b")
    assert a == b
    assert "seed" not in json.dumps(a)


def spread_bot(state: dict) -> dict:
    """Quotes one tick inside the best bid/ask and leans against inventory."""
    orders = []
    for good, depth in state["order_depths"].items():
        if not depth["bids"] or not depth["asks"]:
            continue
        bid, ask = depth["bids"][0][0], depth["asks"][0][0]
        pos, limit = state["position"][good], state["limits"][good]
        if ask - bid > 2:
            if pos < limit:
                orders.append({"good": good, "price": bid + 1, "qty": min(5, limit - pos)})
            if pos > -limit:
                orders.append({"good": good, "price": ask - 1, "qty": -min(5, limit + pos)})
    return {"cancel_all": True, "orders": orders}


@pytest.mark.parametrize("bot", [None, spread_bot])
def test_backtest_matches_live_lobby(tmp_path, bot):
    """Live lobby = fast-forward 0..K-1, then trade from K. The dataset covers exactly 0..K-1, and
    replaying it with a bot gives the same fills as the live simulator with that bot alone."""
    k = CONFIG.dataset_ticks
    manifest = build_dataset(CONFIG, SEED, tmp_path)
    events = list(read_events(tmp_path / "events.jsonl.gz"))
    assert [e["t"] for e in events] == list(range(k))

    live = MarketSimulator(CONFIG, SEED)
    bt = Backtest(manifest, events, owner="g1")
    participant_fills = 0
    for _ in range(k):
        live.open_tick()
        state = bt.open_next()
        assert state == bot_state(live.driver, "g1")
        response = bot(state) if bot else None
        actions, _ = parse_bot_response("g1", response)
        live_log = live.close_tick({"g1": actions} if actions else {})
        summary = bt.close(response)
        live_fills = [(f.price, f.qty) for f in live_log.fills if "g1" in (f.buyer, f.seller)]
        assert [(f["price"], abs(f["qty"])) for f in summary["fills"]] == live_fills
        participant_fills += len(live_fills)
    assert bt.open_next() is None
    assert (participant_fills > 0) == (bot is not None)

    # The live lobby continues seamlessly from tick K.
    live.open_tick()
    assert live.driver.tick == k


def test_fast_forward_equals_dataset_book(tmp_path):
    build_dataset(CONFIG, SEED, tmp_path)
    ff = MarketSimulator(CONFIG, SEED)
    ff.fast_forward(CONFIG.dataset_ticks)
    replay = Backtest(
        json.loads((tmp_path / "manifest.json").read_text()),
        read_events(tmp_path / "events.jsonl.gz"),
    )
    while replay.open_next() is not None:
        replay.close(None)
    for good in CONFIG.rules().goods:
        assert ff.driver.exchange.books[good].depth() == replay.driver.exchange.books[good].depth()


def test_participant_order_is_seeded_but_fair():
    sim = MarketSimulator(CONFIG, SEED)
    owners = [f"g{i}" for i in range(8)]
    orders = {tuple(sim.driver.participant_order(t, owners)) for t in range(50)}
    assert len(orders) > 40  # reshuffled every tick
    firsts = [sim.driver.participant_order(t, owners)[0] for t in range(800)]
    assert all(firsts.count(o) > 50 for o in owners)
