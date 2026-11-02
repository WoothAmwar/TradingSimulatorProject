"""LobbyRunner._flush must not advance current_tick past order batches that failed to save."""

import asyncio
from collections import defaultdict

from server.runner import LobbyRunner
from server.store import MemoryStore


class FlakyStore(MemoryStore):
    def __init__(self) -> None:
        super().__init__()
        self.order_failures = 1  # how many order_batches inserts fail before one succeeds
        self.delay = 0.0
        self.updates: list[dict] = []

    async def insert(self, table: str, rows: list[dict]) -> None:
        await asyncio.sleep(self.delay)
        if table == "order_batches" and self.order_failures:
            self.order_failures -= 1
            raise RuntimeError("insert failed")
        await super().insert(table, rows)

    async def update_lobby(self, lobby_id: str, fields: dict) -> None:
        self.updates.append(dict(fields))


def make_runner(store: MemoryStore) -> LobbyRunner:
    runner = object.__new__(LobbyRunner)
    runner.lobby_id, runner.store = "lobby", store
    runner._queue, runner._lobby_updates = defaultdict(list), {}
    runner._flush_lock = asyncio.Lock()
    return runner


def test_current_tick_waits_for_order_batches():
    store = FlakyStore()
    runner = make_runner(store)
    runner._queue["order_batches"].append({"tick": 5, "group_id": "g", "actions": []})
    runner._lobby_updates["current_tick"] = 6

    asyncio.run(runner._flush())
    assert store.updates == []
    assert runner._lobby_updates == {"current_tick": 6}

    asyncio.run(runner._flush())
    assert store.updates == [{"current_tick": 6}]
    assert [r["tick"] for r in store.tables["order_batches"]] == [5]


def test_overlapping_flushes_do_not_overtake_unsaved_orders():
    store = FlakyStore()
    store.delay = 0.01
    runner = make_runner(store)

    async def scenario():
        runner._queue["order_batches"].append({"tick": 5, "group_id": "g", "actions": []})
        runner._lobby_updates["current_tick"] = 6
        first = asyncio.create_task(runner._flush())  # e.g. the writer loop
        await asyncio.sleep(0)
        runner._queue["order_batches"].append({"tick": 6, "group_id": "g", "actions": []})
        runner._lobby_updates["current_tick"] = 7
        await runner._flush()  # e.g. detach or finish
        await first

    asyncio.run(scenario())
    saved = {r["tick"] for r in store.tables["order_batches"]}
    assert all(t in saved for u in store.updates for t in range(5, u["current_tick"]))
