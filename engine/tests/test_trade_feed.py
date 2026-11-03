"""The public market feed's group trades: live messages, finished lobbies and replays agree."""

from collections import defaultdict

from fastapi.testclient import TestClient
from test_server import ADMIN, LIVE, LOBBY, FakeBot, make_app, make_store, next_of, select

from market_core.config import resolve_lobby_config
from server.runner import LobbyRunner


def test_viewers_see_each_groups_trades():
    store = make_store()
    select(store, "g1", "s1", "maker")
    select(store, "g2", "s2", "taker")
    app = make_app(store)
    with TestClient(app) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        with client.websocket_connect(f"/ws/market/{LOBBY}") as viewer:
            snap = viewer.receive_json()
            assert snap["group_trades"] == [] and snap["group_stats"] == {}
            client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
            live = []
            while True:
                msg = viewer.receive_json()
                if msg["type"] == "trades":
                    live.extend(msg["trades"])
                    assert all(row["tick"] == msg["tick"] for row in msg["trades"])
                if msg["type"] == "status" and msg["status"] == "finished":
                    break
        runner = app.state.manager.runners[LOBBY]
        expected = runner.trades.snapshot()

    names = {(r["buyer"] or {}).get("name") for r in live} | {
        (r["seller"] or {}).get("name") for r in live
    }
    assert names <= {"Alpha", "Beta", None}
    assert any(r["buyer"] and r["seller"] for r in live), "the groups should trade with each other"
    assert expected["group_trades"] == live
    assert sum(s["trades"] for s in expected["group_stats"].values()) == sum(
        bool(r["buyer"]) + bool(r["seller"]) for r in live
    )

    # Another instance serves the finished lobby from the database: same trades, same totals.
    with TestClient(make_app(store, "i2")) as client:
        with client.websocket_connect(f"/ws/market/{LOBBY}") as viewer:
            snap = next_of(viewer, "snapshot")
    assert snap["status"] == "finished"
    assert snap["group_trades"] == expected["group_trades"]
    assert snap["group_stats"] == expected["group_stats"]

    # A replay of the recorded batches (crash recovery) rebuilds the same log.
    lobby = store.lobbies[LOBBY]
    seed, model = store.secrets[LOBBY]
    config = resolve_lobby_config(lobby.public_config, model)
    batches: dict[int, dict[str, list[dict]]] = defaultdict(dict)
    for row in store.tables["order_batches"]:
        batches[row["tick"]][row["group_id"]] = row["actions"]
    replayed = LobbyRunner(
        LOBBY, config, seed, {"g1": "Alpha", "g2": "Beta"}, store, "paused", FakeBot
    )
    replayed.prepare(batches, config.dataset_ticks + LIVE)
    assert replayed.trades.snapshot() == expected
