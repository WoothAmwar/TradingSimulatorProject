"""End-to-end engine tests over HTTP and WebSockets, backed by the in-memory store. Bots run
in-process here (FakeBot); tests/test_sandbox.py covers the real sandbox."""

import time
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import bots
from server.app import create_app
from server.auth import AuthError
from server.sandbox import BotError, Reply
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


def select(store: MemoryStore, group: str, sid: str, source: str, language: str = "python"):
    """Saves a submission whose source names a strategy below, as the group's active one."""
    store.submissions[sid] = {"id": sid, "title": sid, "language": language, "source": source}
    store.active[(LOBBY, group)] = sid


class FakeBot:
    """Runs one of the strategies below in-process, through the same interface as the sandbox."""

    made: list["FakeBot"] = []

    def __init__(self, language: str, source: str, wasm: bytes | None, label: str) -> None:
        self.language, self.source, self.wasm = language, source, wasm
        self.dead, self.busy, self.closed, self.ticks = None, False, False, 0
        FakeBot.made.append(self)

    async def start(self) -> list[str]:
        if self.source == "broken":
            raise BotError("SyntaxError: invalid syntax", ["printed while loading"])
        return [f"{self.source} ready"]

    async def tick(self, state: dict) -> Reply:
        self.ticks += 1
        if self.source == "crash" and not any(
            b.source == "crash" and b.ticks for b in FakeBot.made[:-1]
        ):
            raise BotError("took longer than 10 s and was stopped")  # only the first bot
        if self.source == "raise" or (self.source == "flaky" and state["tick"] % 2):
            return Reply(None, [], "ZeroDivisionError: division by zero")
        strategy = STRATEGIES.get(self.source, quiet)
        return Reply(strategy(state), [f"{self.source} tick {state['tick']}"])

    def close(self) -> None:
        self.closed = True


def make_app(store: MemoryStore, instance: str = "i1"):
    settings = Settings("http://supabase.test", "secret", (), instance, lease_ttl_seconds=30)
    return create_app(store, FakeVerifier(), settings, FakeBot)


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


def quiet(state: dict) -> dict:
    return {"cancel_all": True, "orders": []}


STRATEGIES = {"maker": maker, "taker": taker, "quiet": quiet, "flaky": maker}


@contextmanager
def watch(client: TestClient, token: str, group: str | None = None):
    """A group's bot monitor, signed in as ``token``."""
    with client.websocket_connect(f"/ws/bot/{LOBBY}") as ws:
        ws.send_json({"type": "auth", "token": token, **({"group_id": group} if group else {})})
        yield ws


def wait_for(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


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
    select(store, "g1", "s1", "maker")
    select(store, "g2", "s2", "taker")
    with TestClient(make_app(store)) as client:
        assert client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN).json() == {"ok": True}
        lobby = store.lobbies[LOBBY]
        assert lobby.status == "scheduled"
        assert lobby.public_config["rules"]["position_limits"] == {"STABLE": 50}
        files, manifest = store.datasets[LOBBY]
        assert manifest["ticks"] == K and set(files) >= {"events.jsonl.gz", "manifest.json"}

        with (
            client.websocket_connect(f"/ws/market/{LOBBY}") as viewer,
            watch(client, "user:u1") as monitor,
        ):
            snap = viewer.receive_json()
            assert snap["type"] == "snapshot" and snap["status"] == "scheduled"
            assert snap["tick"] == K - 1 and len(snap["history"]["STABLE"]) == K // 5
            viewer.send_json({"type": "ping"})  # keep-alive from open pages; ignored

            # Nobody keeps a bot page open: the engine runs both groups' bots by itself; the
            # monitor only watches g1's.
            first = monitor.receive_json()
            assert first["type"] == "snapshot" and first["bot"]["status"] == "waiting"
            assert client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN).status_code == 200
            assert store.lobbies[LOBBY].status == "running"

            seen = []
            while True:
                msg = monitor.receive_json()
                seen.append(msg)
                if msg["type"] == "status" and msg["status"] == "finished":
                    break
            with pytest.raises(WebSocketDisconnect) as exc:
                monitor.receive_json()
            assert exc.value.code == 1000

            first_tick = next_of(viewer, "tick")
            assert first_tick["tick"] == K
            assert [r["online"] for r in first_tick["leaderboard"]] == [True, True]
            final = next_of(viewer, "status")
            while final["status"] != "finished":
                final = next_of(viewer, "status")
            assert [r["name"] for r in final["leaderboard"]] != []

        statuses = [m["bot"] for m in seen if m["type"] == "bot"]
        assert statuses[-1]["status"] == "running" and statuses[-1]["submission"]["id"] == "s1"
        assert [m["tick"] for m in seen if m["type"] == "result"] == list(range(K, K + LIVE))
        console = [line["text"] for m in seen if m["type"] == "console" for line in m["lines"]]
        assert "maker ready" in console and f"maker tick {K}" in console
        assert any(m["type"] == "result" and m["fills"] for m in seen)

        assert store.lobbies[LOBBY].status == "finished"
        assert all(bot.closed for bot in FakeBot.made[-2:])
        # Bots stopping after the end must not replace the final (fair-value) leaderboard.
        final_board = client.app.state.manager.runners[LOBBY].leaderboard
        assert final_board == final["leaderboard"] and "online" not in final_board[0]
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


def test_monitor_access():
    store = make_store()
    store.members["u3"] = "g3"
    store.group_names["g3"] = "Gamma"
    with TestClient(make_app(store)) as client:

        def close_code(token: str, group: str | None = None) -> int:
            with watch(client, token, group) as ws, pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            return exc.value.code

        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        assert close_code("nope") == 4401
        assert close_code("user:u3") == 4403  # g3 is not entered
        assert close_code("user:u1", "g2") == 4403  # members watch only their own group
        with watch(client, "user:admin", "g2") as admin:  # admins may watch any group
            assert admin.receive_json()["type"] == "snapshot"


def test_late_responses_are_refused():
    store = make_store()
    with TestClient(make_app(store)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        runner = client.app.state.manager.runners[LOBBY]
        wait_for(lambda: runner._accepting is not None)
        notice = runner.submit_response("g1", K - 5, {"orders": []})
        assert notice == "response arrived after the deadline"
        client.post(f"/admin/lobbies/{LOBBY}/stop", headers=ADMIN)
        assert store.lobbies[LOBBY].status == "finished"


def test_orders_are_cancelled_when_a_bot_gives_no_reply():
    store = make_store()
    select(store, "g1", "s1", "flaky")  # quotes on even ticks, raises on odd ones
    with TestClient(make_app(store)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        wait_for(lambda: store.lobbies[LOBBY].status == "finished")
    g1 = {r["tick"]: r["actions"] for r in store.tables["order_batches"] if r["group_id"] == "g1"}
    odd = [acts for t, acts in g1.items() if t % 2]
    assert odd and all([a["type"] for a in acts] == ["cancel_all"] for acts in odd)


def test_bots_follow_the_active_submission(monkeypatch):
    monkeypatch.setattr(bots, "SYNC_EVERY_S", 0.1)
    monkeypatch.setattr(bots, "RESTART_DELAYS_S", (0.2,))
    store = make_store()
    store.lobbies[LOBBY].public_config["live_ticks"] = 400
    select(store, "g1", "s1", "maker")
    select(store, "g2", "s2", "broken")
    with TestClient(make_app(store)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        runner = client.app.state.manager.runners[LOBBY]
        g1, g2 = runner.bots.group("g1"), runner.bots.group("g2")
        wait_for(lambda: g1.status == "running" and g1.answered > 0)
        # Code that doesn't load stops with its error and isn't retried until the selection changes.
        assert g2.status == "stopped" and "didn't start" in g2.message
        assert {"kind": "error", "text": "SyntaxError: invalid syntax"} in g2.console
        assert {"kind": "log", "text": "printed while loading"} in g2.console

        # A group renamed mid-round shows its new name on the leaderboard.
        store.group_names["g1"] = "Alpha Prime"
        wait_for(lambda: any(r["name"] == "Alpha Prime" for r in runner.leaderboard))

        # A new selection takes over: the old bot stops and its resting orders are cancelled.
        old = g1.bot
        select(store, "g1", "s3", "quiet")
        wait_for(lambda: g1.status == "running" and g1.selection.submission_id == "s3")
        assert old.closed
        cancel_only = [{"type": "cancel_all", "owner": "g1", "good": None}]
        wait_for(
            lambda: any(
                b["group_id"] == "g1" and b["actions"] == cancel_only
                for b in store.tables["order_batches"]
            )
        )

        # A crash restarts the bot after a delay; run() raising only skips that tick.
        FakeBot.made.clear()
        select(store, "g2", "s4", "crash")
        wait_for(lambda: g2.crashes == 1 and "restarts in" in (g2.message or ""))
        wait_for(lambda: g2.status == "running" and g2.answered > 0)
        select(store, "g2", "s5", "raise")
        wait_for(lambda: any("ZeroDivisionError" in line["text"] for line in g2.console))
        assert g2.status == "running"

        # No selection: no bot, and the group shows as offline.
        store.active.pop((LOBBY, "g2"))
        wait_for(lambda: g2.status == "none")
        assert {r["group_id"]: r["online"] for r in runner.leaderboard} == {
            "g1": True,
            "g2": False,
        }
        client.post(f"/admin/lobbies/{LOBBY}/stop", headers=ADMIN)


def test_cpp_bot_waits_for_its_build(monkeypatch):
    monkeypatch.setattr(bots, "SYNC_EVERY_S", 0.1)
    store = make_store()
    store.lobbies[LOBBY].public_config["live_ticks"] = 400
    select(store, "g1", "s1", "maker", language="cpp")
    with TestClient(make_app(store)) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        g1 = client.app.state.manager.runners[LOBBY].bots.group("g1")
        wait_for(lambda: g1.status == "stopped" and "no compiled build" in g1.message)
        store.builds[("g1", "s1")] = b"\0asm build"  # the browser finished uploading it
        wait_for(lambda: g1.status == "running")
        assert g1.bot.wasm == b"\0asm build"
        client.post(f"/admin/lobbies/{LOBBY}/stop", headers=ADMIN)


def test_recovery_replays_to_identical_state():
    store = make_store()
    store.lobbies[LOBBY].public_config["live_ticks"] = 200  # long enough to pause mid-way
    select(store, "g1", "s1", "maker")
    app1 = make_app(store, "instance-a")
    with TestClient(app1) as client:
        client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        client.post(f"/admin/lobbies/{LOBBY}/start", headers=ADMIN)
        runner1 = app1.state.manager.runners[LOBBY]
        wait_for(lambda: runner1.bots.group("g1").answered >= 8)
        assert client.post(f"/admin/lobbies/{LOBBY}/pause", headers=ADMIN).status_code == 200
        time.sleep(TICK_MS / 1000 * 2)  # let the in-flight tick finish
    # Leaving the client shuts the instance down: it flushes, detaches and releases the lease.
    assert store.lobbies[LOBBY].status == "paused"
    assert runner1.bots.group("g1").bot is None  # stopped along with the instance
    acct1 = runner1.sim.driver.exchange.accounts["g1"]
    assert any(acct1.position.values()) or acct1.cash != 0

    app2 = make_app(store, "instance-b")
    with TestClient(app2):
        manager = app2.state.manager
        wait_for(lambda: LOBBY in manager.runners)
        runner2 = manager.runners[LOBBY]
        assert runner2.status == "paused"
        assert runner2.sim.tick == runner1.sim.tick
        acct2 = runner2.sim.driver.exchange.accounts["g1"]
        assert (acct2.cash, acct2.position) == (acct1.cash, acct1.position)
        assert runner2.sim.driver.exchange.books["STABLE"].depth() == (
            runner1.sim.driver.exchange.books["STABLE"].depth()
        )
        # The bot starts again on the new instance, ready for when the lobby resumes.
        wait_for(lambda: runner2.bots.is_running("g1"))


STATIC = "round-1"


def add_static_round(store: MemoryStore, status: str = "draft") -> None:
    store.lobbies[STATIC] = LobbyRecord(
        id=STATIC,
        name="Best time",
        status=status,
        public_config={"preset": "BEST_TIME", "goods": ["STOCK"], "dataset_ticks": 50},
        current_tick=None,
        max_groups=20,
        kind="static",
    )
    store.secrets[STATIC] = (987654321, {"preset": "BEST_TIME"})


def test_static_round_publishes_data_and_never_runs_live():
    store = make_store()
    add_static_round(store)
    with TestClient(make_app(store)) as client:
        assert client.post(f"/admin/lobbies/{STATIC}/prepare", headers=ADMIN).status_code == 200
        lobby = store.lobbies[STATIC]
        assert lobby.status == "scheduled"
        assert lobby.public_config["rules"]["position_limits"] == {"STOCK": 1}
        assert len(lobby.public_config["preview"]["STOCK"]) == 50
        files, manifest = store.datasets[STATIC]
        assert manifest["kind"] == "series" and set(files) == {
            "events.jsonl.gz",
            "prices.csv",
            "manifest.json",
        }

        r = client.post(f"/admin/lobbies/{STATIC}/start", headers=ADMIN)
        assert r.status_code == 409 and "admin panel" in r.json()["detail"]
        with client.websocket_connect(f"/ws/market/{STATIC}") as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4404

    lobby.status = "running"  # opened for submissions from the admin panel
    app = make_app(store, "i2")
    with TestClient(app):
        time.sleep(0.2)  # let startup recovery run
        assert STATIC not in app.state.manager.runners
        assert STATIC not in store.leases


def test_static_round_rejects_unknown_preset():
    store = make_store()
    add_static_round(store)
    store.lobbies[STATIC].public_config["preset"] = "NOPE"
    store.secrets[STATIC] = (1, {})
    with TestClient(make_app(store)) as client:
        r = client.post(f"/admin/lobbies/{STATIC}/prepare", headers=ADMIN)
        assert r.status_code == 400 and "preset" in r.json()["detail"]
        assert store.lobbies[STATIC].status == "draft"


def test_lobby_trades_exactly_one_good():
    store = make_store()
    store.lobbies[LOBBY].public_config["goods"] = ["STABLE", "VOLATILE"]
    store.secrets[LOBBY] = (1, {"goods": ["STABLE", "VOLATILE"], "overrides": {}})
    with TestClient(make_app(store)) as client:
        r = client.post(f"/admin/lobbies/{LOBBY}/prepare", headers=ADMIN)
        assert r.status_code == 400 and "one good" in r.json()["detail"]
        assert store.lobbies[LOBBY].status == "draft"


def test_monitor_is_asked_to_retry_only_while_lobby_recovers():
    store = make_store()
    store.lobbies[LOBBY].status = "running"  # in the DB, but no runner on this instance yet
    app = make_app(store)
    client = TestClient(app)  # no lifespan, so recovery never actually runs

    def close_code() -> int:
        with client.websocket_connect(f"/ws/bot/{LOBBY}") as ws:
            ws.send_json({"type": "auth", "token": "user:u1"})
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
        return exc.value.code

    app.state.manager.recovering.add(LOBBY)
    assert close_code() == 1013
    app.state.manager.recovering.discard(LOBBY)  # recovery gave up or failed
    assert close_code() == 4404
