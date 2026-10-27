"""End-to-end engine tests over HTTP and WebSockets, backed by the in-memory store."""

import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import create_app
from server.auth import AuthError
from server.settings import Settings
from server.store import LobbyRecord, MemoryStore

LOBBY = "lobby-1"
K, LIVE, TICK_MS = 30, 12, 200


class FakeVerifier:
    async def verify(self, token: str) -> str:
        if not token.startswith("user:"):
            raise AuthError("bad token")
        return token.removeprefix("user:")


def make_store() -> MemoryStore:
    store = MemoryStore(
        admins={"admin"},
        members={"u1": "g1", "u2": "g2"},
        group_names={"g1": "Alpha", "g2": "Beta"},
    )
    store.lobbies[LOBBY] = LobbyRecord(
        id=LOBBY,
        name="Test lobby",
        status="draft",
        public_config={
            "goods": ["STABLE"],
            "tick_ms": TICK_MS,
            "dataset_ticks": K,
            "live_ticks": LIVE,
        },
        current_tick=None,
        max_groups=10,
    )
    store.secrets[LOBBY] = (123456789, {"goods": ["STABLE"], "overrides": {}})
    store.entries[LOBBY] = ["g1", "g2"]
    return store


def make_app(store: MemoryStore, instance: str = "i1"):
    settings = Settings("http://supabase.test", "secret", (), instance, lease_ttl_seconds=30)
    return create_app(store, FakeVerifier(), settings)


ADMIN = {"Authorization": "Bearer user:admin"}


def next_of(ws, kind: str) -> dict:
    while True:
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg


def maker(state: dict) -> dict:
    """Quotes one tick inside the spread every tick."""
    orders = []
    for good, depth in state["order_depths"].items():
        if depth["bids"] and depth["asks"] and depth["asks"][0][0] - depth["bids"][0][0] > 2:
            orders.append({"good": good, "price": depth["bids"][0][0] + 1, "qty": 3})
            orders.append({"good": good, "price": depth["asks"][0][0] - 1, "qty": -3})
    return {"cancel_all": True, "orders": orders}


def taker(state: dict) -> dict:
    """Lifts the best ask with a small IOC order every tick."""
    orders = []
    for good, depth in state["order_depths"].items():
        if depth["asks"] and state["position"][good] < state["limits"][good]:
            orders.append({"good": good, "price": depth["asks"][0][0], "qty": 1, "tif": "IOC"})
    return {"orders": orders}


def test_admin_auth():
    with TestClient(make_app(make_store())) as client:
        assert client.post(f"/admin/lobbies/{LOBBY}/prepare").status_code == 401
        r = client.post(
            f"/admin/lobbies/{LOBBY}/prepare", headers={"Authorization": "Bearer user:u1"}
        )
        assert r.status_code == 403
        r = client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        assert r.status_code == 409 and "draft" in r.json()["detail"]


def test_full_lobby_lifecycle():
    store = make_store()
    with TestClient(make_app(store)) as client:
        assert client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN).json() == {"ok": True}
        lobby = store.lobbies[LOBBY]
        assert lobby.status == "scheduled"
        assert lobby.public_config["rules"]["position_limits"] == {"STABLE": 50}
        files, manifest = store.datasets[LOBBY]
        assert manifest["ticks"] == K and set(files) >= {"events.jsonl.gz", "manifest.json"}

        with (
            client.websocket_connect(f"/ws/market/{LOBBY}") as viewer,
            client.websocket_connect(f"/ws/trade/{LOBBY}") as t1,
            client.websocket_connect(f"/ws/trade/{LOBBY}") as t2,
        ):
            snap = viewer.receive_json()
            assert snap["type"] == "snapshot" and snap["status"] == "scheduled"
            assert snap["tick"] == K - 1 and len(snap["history"]["STABLE"]) == K // 5
            viewer.send_json({"type": "ping"})  # keep-alive from open pages; ignored

            t1.send_json({"type": "auth", "token": "user:u1"})
            t2.send_json({"type": "auth", "token": "user:u2"})
            assert next_of(t1, "welcome")["group_id"] == "g1"
            assert next_of(t2, "welcome")["group_id"] == "g2"

            assert client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN).status_code == 200
            assert store.lobbies[LOBBY].status == "running"

            seen_ticks = []
            for _ in range(LIVE):
                s1, s2 = next_of(t1, "state"), next_of(t2, "state")
                assert s1["tick"] == s2["tick"]
                seen_ticks.append(s1["tick"])
                t1.send_json({"type": "orders", "tick": s1["tick"], "response": maker(s1["state"])})
                t2.send_json({"type": "orders", "tick": s2["tick"], "response": taker(s2["state"])})
            assert seen_ticks == list(range(K, K + LIVE))

            assert next_of(viewer, "tick")["tick"] >= K
            final = next_of(viewer, "status")
            while final["status"] != "finished":
                final = next_of(viewer, "status")
            assert [r["name"] for r in final["leaderboard"]] != []

        assert store.lobbies[LOBBY].status == "finished"
        results = store.results_rows[LOBBY]
        assert sorted(r["group_id"] for r in results) == ["g1", "g2"]
        assert [r["rank"] for r in results] == [1, 2]
        cross = [
            f
            for f in store.tables["participant_fills"]
            if {f["buyer_group"], f["seller_group"]} == {"g1", "g2"}
        ]
        assert cross, "the taker group should have traded against the maker group's quotes"
        assert store.tables["order_batches"] and store.tables["market_snapshots"]
        assert LOBBY not in store.leases  # released when the lobby finished


def test_late_and_unauthorized_traders():
    store = make_store()
    store.members["u3"] = "g3"
    store.group_names["g3"] = "Gamma"
    with TestClient(make_app(store)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        with client.websocket_connect(f"/ws/trade/{LOBBY}") as ws:
            ws.send_json({"type": "auth", "token": "nope"})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4401
        with client.websocket_connect(f"/ws/trade/{LOBBY}") as ws:
            ws.send_json({"type": "auth", "token": "user:u3"})  # g3 is not entered
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4403
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        with client.websocket_connect(f"/ws/trade/{LOBBY}") as ws:
            ws.send_json({"type": "auth", "token": "user:u1"})
            state = next_of(ws, "state")
            ws.send_json({"type": "ping"})  # keep-alive: must not produce a notice
            ws.send_json({"type": "orders", "tick": state["tick"] - 5, "response": {}})
            msg = ws.receive_json()
            while msg["type"] in ("state", "result"):
                msg = ws.receive_json()
            assert msg["type"] == "late" and msg["tick"] == state["tick"] - 5
        client.post(f"/admin/lobbies/{LOBBY}/stop", headers=ADMIN)
        assert store.lobbies[LOBBY].status == "finished"


def test_recovery_replays_to_identical_state():
    store = make_store()
    store.lobbies[LOBBY].public_config["live_ticks"] = 200  # long enough to pause mid-way
    app1 = make_app(store, "instance-a")
    with TestClient(app1) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        with client.websocket_connect(f"/ws/trade/{LOBBY}") as t1:
            t1.send_json({"type": "auth", "token": "user:u1"})
            for _ in range(8):
                s = next_of(t1, "state")
                t1.send_json({"type": "orders", "tick": s["tick"], "response": maker(s["state"])})
        assert client.post(f"/admin/lobbies/{LOBBY}/pause", headers=ADMIN).status_code == 200
        time.sleep(TICK_MS / 1000 * 2)  # let the in-flight tick finish
        runner1 = app1.state.manager.runners[LOBBY]
    # Leaving the client shuts the instance down: it flushes, detaches and releases the lease.
    assert store.lobbies[LOBBY].status == "paused"
    acct1 = runner1.sim.driver.exchange.accounts["g1"]
    assert any(acct1.position.values()) or acct1.cash != 0

    app2 = make_app(store, "instance-b")
    with TestClient(app2):
        manager = app2.state.manager
        for _ in range(100):
            if LOBBY in manager.runners:
                break
            time.sleep(0.05)
        runner2 = manager.runners[LOBBY]
        assert runner2.status == "paused"
        assert runner2.sim.tick == runner1.sim.tick
        acct2 = runner2.sim.driver.exchange.accounts["g1"]
        assert (acct2.cash, acct2.position) == (acct1.cash, acct1.position)
        assert runner2.sim.driver.exchange.books["STABLE"].depth() == (
            runner1.sim.driver.exchange.books["STABLE"].depth()
        )
