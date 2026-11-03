"""One lobby's live market: the tick loop, the groups' bots, viewers, and persistence.

Each tick ``t``:
  open   -> bot maker quotes; broadcast the public book; hand each group's bot its state
  wait   -> collect at most one response per group until CLOSE_FRACTION of the tick has passed
  close  -> participant batches (seeded order) then bot takers; persist; report results
Every applied batch is written to ``order_batches`` so a restarted engine can replay the lobby.
The groups' bots run on this engine (server/bots.py), so nobody has to keep a page open.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from fastapi import WebSocket

from market_core.config import LobbyConfig
from market_core.exchange import TickLog
from market_core.protocol import parse_bot_response
from market_core.simulator import MarketSimulator
from market_core.types import Action, CancelAll, Fill, action_from_dict, action_to_dict, is_bot

from .bots import START_WAIT_S, BotFactory, BotPool
from .store import Store
from .trades import TradeLog

log = logging.getLogger("engine.runner")

CLOSE_FRACTION = 0.85  # share of each tick that bots have to respond
DATASET_HISTORY_STRIDE = 5  # chart history keeps every 5th dataset tick
LEADERBOARD_EVERY = 5
PNL_SNAPSHOT_EVERY = 10
MAX_ACTIONS_PER_RESPONSE = 300


def _now() -> str:
    return datetime.now(UTC).isoformat()


class LobbyRunner:
    def __init__(
        self,
        lobby_id: str,
        config: LobbyConfig,
        seed: int,
        groups: dict[str, str],
        store: Store,
        status: str,
        bot_factory: BotFactory,
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
        self.trades = TradeLog()  # groups' fills, shown to viewers
        self.viewers: set[WebSocket] = set()
        self.bots = BotPool(self, store, bot_factory)
        self.on_finished: Callable[[LobbyRunner], Awaitable[None]] | None = None
        self._pending: dict[str, list[Action]] = {}
        self._pending_rejects: dict[str, list[str]] = {}
        self._carry: dict[str, list[Action]] = {}  # e.g. a stopped bot's cancel, for the next tick
        self._responded: set[str] = set()
        self._accepting: int | None = None
        self._resume = asyncio.Event()
        self._queue: dict[str, list[dict]] = defaultdict(list)
        self._lobby_updates: dict = {}
        self._flush_lock = asyncio.Lock()  # writer, detach and finish may flush concurrently
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
        open_log = self.sim.open_tick()
        mids = self._mids()
        self._update_marks()
        if record:
            self._record_history(t)
        close_log = self.sim.close_tick(batches)
        self.trades.add_fills(t, open_log.fills + close_log.fills, mids, self.groups)

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
        await self.announce({"type": "status", "status": "paused", "tick": self.tick})

    async def resume(self) -> None:
        self.status = "running"
        self._resume.set()
        await self.announce({"type": "status", "status": "running", "tick": self.tick})

    async def announce(self, msg: dict) -> None:
        """A status change: for viewers and for the groups watching their bots."""
        await asyncio.gather(self._broadcast(msg), self.bots.broadcast(msg))

    async def stop(self) -> None:
        """Ends the lobby: final scores at fair value, results persisted."""
        await self._halt()
        await self._finish()

    async def detach(self) -> None:
        """Stops running here without finishing (another instance owns the lobby now)."""
        await self._halt()
        await self._flush()
        await self.bots.close(4002, "Lobby moved to another engine instance")
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
        try:
            # Every bot gets the same chance at the first tick, within reason.
            await self.bots.sync(wait=START_WAIT_S)
            next_open = loop.time()
            while self.sim.tick < self.end_tick and not self._stopping:
                if not self._resume.is_set():
                    await self._resume.wait()
                    if self._stopping:
                        return
                    next_open = loop.time()
                self.bots.maybe_sync()
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
        mids = self._mids()
        self._update_marks()
        self._record_history(t)
        self._pending, self._pending_rejects = dict(self._carry), {}
        self._carry = {}
        self._responded = set()
        self._accepting = t
        close_at = opened_at + tick_s * CLOSE_FRACTION
        self._queue_market_snapshot(t, open_log)
        await self._broadcast(self._tick_message(t))
        self.bots.send_states(t)

        wait = close_at - loop.time()
        if wait > 0:
            await asyncio.sleep(wait)
        self._accepting = None
        batches, self._pending = self._pending, {}
        close_log = self.sim.close_tick(batches)
        self._update_marks()
        self._update_leaderboard()
        self._queue_close(t, batches, open_log, close_log)
        trades = self.trades.add_fills(t, open_log.fills + close_log.fills, mids, self.groups)
        if trades:
            await self._broadcast({"type": "trades", "tick": t, "trades": trades})
        await self.bots.after_close(t, open_log, close_log)

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
        await self.announce(
            {
                "type": "status",
                "status": "finished",
                "tick": self.tick,
                "leaderboard": self.leaderboard,
            }
        )
        await self.bots.close(1000, "Lobby finished")
        if self._writer:
            self._writer.cancel()
        if self.on_finished:
            await self.on_finished(self)

    # Groups' bots (server/bots.py) ------------------------------------------------------

    def submit_response(self, group_id: str, tick: int, response: dict | None) -> str | None:
        """Accepts one response per group per tick; returns why it was refused, if it was."""
        if self._accepting is None or tick != self._accepting:
            return "response arrived after the deadline"
        if group_id in self._responded:
            return "a response for this tick was already in"
        actions, rejects = parse_bot_response(group_id, response)
        carried = self._pending.get(group_id, [])  # e.g. a cancel from when its last bot stopped
        self._pending[group_id] = carried + actions[:MAX_ACTIONS_PER_RESPONSE]
        self._pending_rejects[group_id] = [r.reason for r in rejects]
        if len(actions) > MAX_ACTIONS_PER_RESPONSE:
            self._pending_rejects[group_id].append("too many actions; extra ignored")
        self._responded.add(group_id)
        return None

    def cancel_orders(self, group_id: str) -> None:
        """Cancels a group's resting orders once its bot stops. Goes through a recorded batch so
        replays stay deterministic."""
        if self.status not in ("running", "paused"):
            return
        cancel = [CancelAll(group_id)]
        if self._accepting is not None and group_id not in self._pending:
            self._pending[group_id] = cancel
        else:
            self._carry[group_id] = cancel

    def account_summary(self, group_id: str) -> dict:
        acct = self.sim.driver.exchange.accounts.get(group_id)
        return {
            "position": {g: (acct.position.get(g, 0) if acct else 0) for g in self.goods},
            "cash": acct.cash if acct else 0,
            "pnl": self._pnl(group_id, self.marks),
        }

    def result_message(self, group_id: str, t: int, open_log: TickLog, close_log: TickLog) -> dict:
        """What a group's bot did in tick ``t``: its fills and rejects, then its account."""
        fills = [
            {"good": f.good, "price": f.price, "qty": f.qty if f.buyer == group_id else -f.qty}
            for f in open_log.fills + close_log.fills
            if group_id in (f.buyer, f.seller)
        ]
        exchange_rejects = [
            r.reason for r in open_log.rejects + close_log.rejects if r.owner == group_id
        ]
        return {
            "type": "result",
            "tick": t,
            "fills": fills,
            "rejects": self._pending_rejects.get(group_id, []) + exchange_rejects,
            **self.account_summary(group_id),
        }

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
            **self.trades.snapshot(),
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

    def _mids(self) -> dict[str, float | None]:
        return {g: book.mid() for g, book in self.sim.driver.exchange.books.items()}

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
        # "online": the group's bot is running. Groups without one keep their units, so their
        # score still moves with the price.
        rows = [
            {
                "group_id": g,
                "name": n,
                "pnl": self._pnl(g, self.marks),
                "online": self.bots.is_running(g),
            }
            for g, n in self.groups.items()
        ]
        self.leaderboard = sorted(rows, key=lambda r: r["pnl"], reverse=True)

    def _tick_message(self, t: int) -> dict:
        state = self.sim.driver.public_state()
        msg = {
            "type": "tick",
            "tick": t,
            "books": state["order_depths"],
            "trades": state["market_trades"],
            "mids": self._mids(),
        }
        if t % LEADERBOARD_EVERY == 0:
            msg["leaderboard"] = self.leaderboard
        return msg

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
        async with self._flush_lock:
            # Taken together so current_tick never covers ticks whose rows are still queued.
            queue, self._queue = self._queue, defaultdict(list)
            updates, self._lobby_updates = self._lobby_updates, {}
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
                    if table == "order_batches" and "current_tick" in updates:
                        # Recovery replays up to current_tick, so don't advance it past saved orders.
                        self._lobby_updates.setdefault("current_tick", updates.pop("current_tick"))
            if updates:
                try:
                    await self.store.update_lobby(self.lobby_id, updates)
                except Exception:
                    log.exception("lobby update failed")
