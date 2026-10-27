"""One lobby's live market: the tick loop, connected bots and viewers, and persistence.

Each tick ``t``:
  open   -> bot maker quotes; broadcast the public book; send each bot its private state
  wait   -> collect at most one response per group until CLOSE_FRACTION of the tick has passed
  close  -> participant batches (seeded order) then bot takers; persist; send results
Every applied batch is written to ``order_batches`` so a restarted engine can replay the lobby.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import WebSocket

from market_core.config import LobbyConfig
from market_core.exchange import TickLog
from market_core.protocol import bot_state, parse_bot_response
from market_core.simulator import MarketSimulator
from market_core.types import Action, CancelAll, Fill, action_from_dict, action_to_dict, is_bot

from .store import Store

log = logging.getLogger("engine.runner")

CLOSE_FRACTION = 0.85  # share of each tick that bots have to respond
DATASET_HISTORY_STRIDE = 5  # chart history keeps every 5th dataset tick
LEADERBOARD_EVERY = 5
PNL_SNAPSHOT_EVERY = 10
MAX_ACTIONS_PER_RESPONSE = 300


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(eq=False)
class Trader:
    group_id: str
    user_id: str
    socket: WebSocket


class LobbyRunner:
    def __init__(
        self,
        lobby_id: str,
        config: LobbyConfig,
        seed: int,
        groups: dict[str, str],
        store: Store,
        status: str,
    ) -> None:
        self.lobby_id = lobby_id
        self.config = config
        self.groups = dict(groups)  # group id -> name
        self.store = store
        self.status = status
        self.sim = MarketSimulator(config, seed)
        self.start_tick = config.dataset_ticks
        self.end_tick = config.dataset_ticks + config.live_ticks
        self.goods = [g.name for g in config.goods]
        self.history: dict[str, list[list[float]]] = {g: [] for g in self.goods}
        self.marks: dict[str, float] = {}
        self.leaderboard: list[dict] = []
        self.viewers: set[WebSocket] = set()
        self.traders: dict[str, Trader] = {}
        self.on_finished: Callable[[LobbyRunner], Awaitable[None]] | None = None
        self._pending: dict[str, list[Action]] = {}
        self._pending_rejects: dict[str, list[str]] = {}
        self._carry: dict[str, list[Action]] = {}  # e.g. cancel-on-disconnect for the next tick
        self._responded: set[str] = set()
        self._accepting: int | None = None
        self._resume = asyncio.Event()
        self._queue: dict[str, list[dict]] = defaultdict(list)
        self._lobby_updates: dict = {}
        self._task: asyncio.Task | None = None
        self._writer: asyncio.Task | None = None
        self._stopping = False
        self._finished = False

    # Building state (synchronous; run in a worker thread) --------------------------------

    def prepare(
        self, batches: dict[int, dict[str, list[dict]]] | None = None, until: int | None = None
    ):
        """Fast-forward the bot-only dataset ticks, then replay recorded live ticks."""
        while self.sim.tick < self.start_tick:
            self._replay_step({}, self.sim.tick % DATASET_HISTORY_STRIDE == 0)
        batches = batches or {}
        target = min(until if until is not None else self.start_tick, self.end_tick)
        while self.sim.tick < target:
            raw = batches.get(self.sim.tick, {})
            self._replay_step(
                {g: [action_from_dict(a) for a in acts] for g, acts in raw.items()}, True
            )
        self._update_leaderboard()

    def _replay_step(self, batches: dict[str, list[Action]], record: bool) -> None:
        t = self.sim.tick
        self.sim.open_tick()
        self._update_marks()
        if record:
            self._record_history(t)
        self.sim.close_tick(batches)

    # Lifecycle ----------------------------------------------------------------------------

    @property
    def tick(self) -> int | None:
        return self.sim.driver.tick

    def start(self) -> None:
        if self._task is not None:
            return
        if self.status not in ("paused",):
            self.status = "running"
        if self.status == "running":
            self._resume.set()
        self._task = asyncio.create_task(self._run(), name=f"lobby-{self.lobby_id}")
        self._writer = asyncio.create_task(self._write_loop(), name=f"writer-{self.lobby_id}")

    async def pause(self) -> None:
        self.status = "paused"
        self._resume.clear()
        await self._broadcast({"type": "status", "status": "paused", "tick": self.tick})

    async def resume(self) -> None:
        self.status = "running"
        self._resume.set()
        await self._broadcast({"type": "status", "status": "running", "tick": self.tick})

    async def stop(self) -> None:
        """Ends the lobby: final scores at fair value, results persisted."""
        await self._halt()
        await self._finish()

    async def detach(self) -> None:
        """Stops running here without finishing (another instance owns the lobby now)."""
        await self._halt()
        await self._flush()
        for trader in list(self.traders.values()):
            await self._close(trader.socket, 4002, "Lobby moved to another engine instance")
        for ws in list(self.viewers):
            await self._close(ws, 4002, "Lobby moved to another engine instance")

    async def _halt(self) -> None:
        self._stopping = True
        self._resume.set()
        current = asyncio.current_task()
        if self._task and self._task is not current:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        tick_s = self.config.tick_ms / 1000
        next_open = loop.time()
        try:
            while self.sim.tick < self.end_tick and not self._stopping:
                if not self._resume.is_set():
                    await self._resume.wait()
                    if self._stopping:
                        return
                    next_open = loop.time()
                await self._tick(loop, next_open, tick_s)
                next_open += tick_s
                delay = next_open - loop.time()
                if delay > 0:
                    await asyncio.sleep(delay)
                else:  # fell behind: don't burst to catch up
                    next_open = loop.time()
            if not self._stopping:
                await self._finish()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("lobby %s tick loop crashed", self.lobby_id)
            self.status = "paused"
            self._resume.clear()

    async def _tick(self, loop: asyncio.AbstractEventLoop, opened_at: float, tick_s: float) -> None:
        t = self.sim.tick
        open_log = self.sim.open_tick()
        self._update_marks()
        self._record_history(t)
        self._pending, self._pending_rejects = dict(self._carry), {}
        self._carry = {}
        self._responded = set()
        self._accepting = t
        close_at = opened_at + tick_s * CLOSE_FRACTION
        deadline_ms = int(max(0.0, close_at - loop.time()) * 1000)
        self._queue_market_snapshot(t, open_log)
        await self._broadcast(self._tick_message(t))
        await self._send_states(t, deadline_ms)

        wait = close_at - loop.time()
        if wait > 0:
            await asyncio.sleep(wait)
        self._accepting = None
        batches, self._pending = self._pending, {}
        close_log = self.sim.close_tick(batches)
        self._update_marks()
        self._update_leaderboard()
        self._queue_close(t, batches, open_log, close_log)
        await self._send_results(t, open_log, close_log)

    async def _finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        self._stopping = True
        self.status = "finished"
        fair = self.sim.fair_values or self.marks
        scores = sorted(
            ((gid, self._pnl(gid, fair)) for gid in self.groups), key=lambda x: x[1], reverse=True
        )
        rows = [
            {"lobby_id": self.lobby_id, "group_id": gid, "final_pnl": round(pnl, 4), "rank": i + 1}
            for i, (gid, pnl) in enumerate(scores)
        ]
        self.leaderboard = [
            {"group_id": gid, "name": self.groups[gid], "pnl": pnl} for gid, pnl in scores
        ]
        await self._flush()
        try:
            await self.store.replace_results(self.lobby_id, rows)
            await self.store.update_lobby(
                self.lobby_id,
                {"status": "finished", "finished_at": _now(), "current_tick": self.tick},
            )
        except Exception:
            log.exception("failed to persist results for %s", self.lobby_id)
        await self._broadcast(
            {
                "type": "status",
                "status": "finished",
                "tick": self.tick,
                "leaderboard": self.leaderboard,
            }
        )
        for trader in list(self.traders.values()):
            await self._close(trader.socket, 1000, "Lobby finished")
        if self._writer:
            self._writer.cancel()
        if self.on_finished:
            await self.on_finished(self)

    # Participants -------------------------------------------------------------------------

    async def add_trader(self, trader: Trader) -> None:
        old = self.traders.get(trader.group_id)
        self.traders[trader.group_id] = trader
        if old is not None:
            await self._close(old.socket, 4001, "Another member started your group's bot")
        await trader.socket.send_json(
            {
                "type": "welcome",
                "group_id": trader.group_id,
                "status": self.status,
                "tick": self.tick,
                "tick_ms": self.config.tick_ms,
                "goods": self.goods,
                "limits": self.sim.driver.rules.position_limits,
                "end_tick": self.end_tick,
            }
        )

    def remove_trader(self, trader: Trader) -> None:
        if self.traders.get(trader.group_id) is not trader:
            return
        del self.traders[trader.group_id]
        # Cancel-on-disconnect goes through a recorded batch so replays stay deterministic.
        if self.status in ("running", "paused"):
            cancel = [CancelAll(trader.group_id)]
            if self._accepting is not None and trader.group_id not in self._pending:
                self._pending[trader.group_id] = cancel
            else:
                self._carry[trader.group_id] = cancel

    def handle_trader_message(self, group_id: str, msg: dict) -> dict | None:
        """Accepts one ``orders`` message per group per tick; returns a notice for the bot."""
        if msg.get("type") != "orders":
            return None
        tick = msg.get("tick")
        if self._accepting is None or tick != self._accepting:
            return {"type": "late", "tick": tick, "current": self.tick}
        if group_id in self._responded:
            return {"type": "duplicate", "tick": tick}
        actions, rejects = parse_bot_response(group_id, msg.get("response"))
        carried = self._pending.get(group_id, [])  # e.g. a cancel-on-disconnect from last tick
        self._pending[group_id] = carried + actions[:MAX_ACTIONS_PER_RESPONSE]
        self._pending_rejects[group_id] = [r.reason for r in rejects]
        if len(actions) > MAX_ACTIONS_PER_RESPONSE:
            self._pending_rejects[group_id].append("too many actions; extra ignored")
        self._responded.add(group_id)
        return None

    # Viewers ------------------------------------------------------------------------------

    def snapshot(self) -> dict:
        return {
            "type": "snapshot",
            "status": self.status,
            "tick": self.tick,
            "tick_ms": self.config.tick_ms,
            "goods": self.goods,
            "history": self.history,
            "books": self.sim.driver.public_state()["order_depths"]
            if self.tick is not None
            else {},
            "leaderboard": self.leaderboard,
        }

    async def add_viewer(self, ws: WebSocket) -> None:
        await ws.send_json(self.snapshot())
        self.viewers.add(ws)

    # Internals ----------------------------------------------------------------------------

    def _update_marks(self) -> None:
        for good, book in self.sim.driver.exchange.books.items():
            mid = book.mid()
            if mid is not None:
                self.marks[good] = mid

    def _record_history(self, t: int) -> None:
        for good in self.goods:
            mid = self.sim.driver.exchange.books[good].mid()
            if mid is not None:
                self.history[good].append([t, mid])

    def _pnl(self, group_id: str, marks: dict[str, float]) -> float:
        acct = self.sim.driver.exchange.accounts.get(group_id)
        if acct is None:
            return 0.0
        return acct.cash + sum(q * marks.get(g, 0.0) for g, q in acct.position.items())

    def _update_leaderboard(self) -> None:
        rows = [
            {"group_id": g, "name": n, "pnl": self._pnl(g, self.marks)}
            for g, n in self.groups.items()
        ]
        self.leaderboard = sorted(rows, key=lambda r: r["pnl"], reverse=True)

    def _tick_message(self, t: int) -> dict:
        state = self.sim.driver.public_state()
        books = self.sim.driver.exchange.books
        msg = {
            "type": "tick",
            "tick": t,
            "books": state["order_depths"],
            "trades": state["market_trades"],
            "mids": {g: books[g].mid() for g in self.goods},
        }
        if t % LEADERBOARD_EVERY == 0:
            msg["leaderboard"] = self.leaderboard
        return msg

    async def _send_states(self, t: int, deadline_ms: int) -> None:
        sends = [
            self._send(
                trader.socket,
                {
                    "type": "state",
                    "tick": t,
                    "deadline_ms": deadline_ms,
                    "state": bot_state(self.sim.driver, gid),
                },
            )
            for gid, trader in list(self.traders.items())
        ]
        await asyncio.gather(*sends)

    async def _send_results(self, t: int, open_log: TickLog, close_log: TickLog) -> None:
        fills = open_log.fills + close_log.fills
        for gid, trader in list(self.traders.items()):
            acct = self.sim.driver.exchange.accounts.get(gid)
            exchange_rejects = [
                r.reason for r in open_log.rejects + close_log.rejects if r.owner == gid
            ]
            await self._send(
                trader.socket,
                {
                    "type": "result",
                    "tick": t,
                    "fills": [
                        {
                            "good": f.good,
                            "price": f.price,
                            "qty": f.qty if f.buyer == gid else -f.qty,
                        }
                        for f in fills
                        if gid in (f.buyer, f.seller)
                    ],
                    "rejects": self._pending_rejects.get(gid, []) + exchange_rejects,
                    "position": {g: (acct.position.get(g, 0) if acct else 0) for g in self.goods},
                    "cash": acct.cash if acct else 0,
                    "pnl": self._pnl(gid, self.marks),
                },
            )

    async def _broadcast(self, msg: dict) -> None:
        dead = []
        for ws, ok in zip(
            list(self.viewers),
            await asyncio.gather(*(self._send(ws, msg) for ws in list(self.viewers))),
            strict=True,
        ):
            if not ok:
                dead.append(ws)
        for ws in dead:
            self.viewers.discard(ws)

    @staticmethod
    async def _send(ws: WebSocket, msg: dict) -> bool:
        try:
            await asyncio.wait_for(ws.send_json(msg), timeout=2)
            return True
        except Exception:
            return False

    @staticmethod
    async def _close(ws: WebSocket, code: int, reason: str) -> None:
        try:
            await ws.close(code=code, reason=reason)
        except Exception:
            pass

    # Persistence --------------------------------------------------------------------------

    def _queue_market_snapshot(self, t: int, open_log: TickLog) -> None:
        books = self.sim.driver.exchange.books
        fills = self.sim.driver.recent_fills
        for good in self.goods:
            book = books[good]
            good_fills = [f for f in fills if f.good == good]
            self._queue["market_snapshots"].append(
                {
                    "lobby_id": self.lobby_id,
                    "tick": t,
                    "good": good,
                    "best_bid": book.best_bid(),
                    "best_ask": book.best_ask(),
                    "mid": book.mid(),
                    "last_price": good_fills[-1].price if good_fills else None,
                    "volume": sum(f.qty for f in good_fills),
                }
            )

    def _queue_close(
        self, t: int, batches: dict[str, list[Action]], open_log: TickLog, close_log: TickLog
    ) -> None:
        for gid, actions in batches.items():
            if actions:
                self._queue["order_batches"].append(
                    {
                        "lobby_id": self.lobby_id,
                        "tick": t,
                        "group_id": gid,
                        "actions": [action_to_dict(a) for a in actions],
                    }
                )
        for fill in open_log.fills + close_log.fills:
            if self._is_participant_fill(fill):
                self._queue["participant_fills"].append(
                    {
                        "lobby_id": self.lobby_id,
                        "tick": t,
                        "good": fill.good,
                        "price": fill.price,
                        "qty": fill.qty,
                        "buyer_group": None if is_bot(fill.buyer) else fill.buyer,
                        "seller_group": None if is_bot(fill.seller) else fill.seller,
                        "aggressor": fill.aggressor,
                    }
                )
        if t % PNL_SNAPSHOT_EVERY == 0:
            for gid in self.groups:
                acct = self.sim.driver.exchange.accounts.get(gid)
                self._queue["pnl_snapshots"].append(
                    {
                        "lobby_id": self.lobby_id,
                        "group_id": gid,
                        "tick": t,
                        "cash": acct.cash if acct else 0,
                        "positions": dict(acct.position) if acct else {},
                        "pnl": round(self._pnl(gid, self.marks), 4),
                    }
                )
        # Next tick to open; crash recovery replays exactly up to here.
        self._lobby_updates["current_tick"] = t + 1

    @staticmethod
    def _is_participant_fill(fill: Fill) -> bool:
        return not (is_bot(fill.buyer) and is_bot(fill.seller))

    async def _write_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            await self._flush()

    async def _flush(self) -> None:
        queue, self._queue = self._queue, defaultdict(list)
        # order_batches first: they are what crash recovery replays.
        for table in ("order_batches", "participant_fills", "market_snapshots", "pnl_snapshots"):
            rows = queue.get(table)
            if not rows:
                continue
            try:
                await self.store.insert(table, rows)
            except Exception:
                log.exception("insert into %s failed; retrying next flush", table)
                self._queue[table][:0] = rows
        if self._lobby_updates:
            updates, self._lobby_updates = self._lobby_updates, {}
            try:
                await self.store.update_lobby(self.lobby_id, updates)
            except Exception:
                log.exception("lobby update failed")
