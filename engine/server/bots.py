"""Runs every entered group's active submission for one live lobby, on the engine itself.

Each tick the pool hands every running bot its state and passes the bot's reply to the runner,
which accepts it like any order batch if it arrives before the tick closes. A changed selection
takes over within SYNC_EVERY_S; a crashed bot restarts after a delay, with its memory cleared.
Members watch their group's bot over a monitor socket: status, console output, fills and stats.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from fastapi import WebSocket

from market_core.exchange import TickLog
from market_core.protocol import bot_state

from .sandbox import BotError, Reply, Sandbox, make_bot
from .store import Store

if TYPE_CHECKING:
    from .runner import LobbyRunner

log = logging.getLogger("engine.bots")

SYNC_EVERY_S = 5.0  # how soon a newly picked submission takes over
START_WAIT_S = 20.0  # the first tick waits this long for bots to start
RESTART_DELAYS_S = (10, 30, 60, 120, 300)  # after the 1st, 2nd, ... crash in a row
CONSOLE_LINES = 300  # kept for monitors that connect later
RECENT_FILLS = 40
NATIVE = ("c", "cpp")


class Bot(Protocol):
    language: str
    dead: str | None

    @property
    def busy(self) -> bool: ...

    async def start(self) -> list[str]: ...

    async def tick(self, state: dict) -> Reply: ...

    def close(self) -> None: ...


# (language, source, compiled build for C/C++, label) -> a bot that hasn't started yet
BotFactory = Callable[[str, str, bytes | None, str], Bot]


class SandboxFactory:
    """Makes bots in one wasmtime sandbox, created along with the first bot."""

    def __init__(self, python_dir: Path) -> None:
        self.python_dir = python_dir
        self._sandbox: Sandbox | None = None

    def __call__(self, language: str, source: str, wasm: bytes | None, label: str) -> Bot:
        if self._sandbox is None:
            self._sandbox = Sandbox(self.python_dir)
        return make_bot(self._sandbox, language, source, wasm, label)


@dataclass
class Selection:
    submission_id: str
    title: str
    language: str
    source: str = field(repr=False)
    wasm: bytes | None = field(default=None, repr=False)


@dataclass(eq=False)
class GroupBot:
    wanted: str | None = None  # the active submission last read from the database
    reload: bool = True  # read it again at the next sync (e.g. its C/C++ build was missing)
    selection: Selection | None = None
    bot: Bot | None = None
    status: str = "waiting"  # waiting | none | starting | running | stopped
    message: str | None = None
    generation: int = 0  # bumped whenever the bot is replaced, so stale tasks can tell
    crashes: int = 0  # in a row; reset once a bot answers a tick
    restart_at: float | None = None
    answered: int = 0
    missed: int = 0
    rejects: int = 0
    avg_ms: float = 0.0
    console: deque = field(default_factory=lambda: deque(maxlen=CONSOLE_LINES))
    fills: deque = field(default_factory=lambda: deque(maxlen=RECENT_FILLS))  # newest first
    monitors: set[WebSocket] = field(default_factory=set)

    def info(self) -> dict:
        sel = self.selection
        return {
            "status": self.status,
            "message": self.message,
            "submission": (
                {"id": sel.submission_id, "title": sel.title, "language": sel.language}
                if sel
                else None
            ),
        }

    def stats(self) -> dict:
        return {
            "answered": self.answered,
            "missed": self.missed,
            "rejects": self.rejects,
            "avg_ms": round(self.avg_ms, 1),
        }


class BotPool:
    def __init__(self, runner: LobbyRunner, store: Store, factory: BotFactory) -> None:
        self.runner = runner
        self.store = store
        self.factory = factory
        self.groups: dict[str, GroupBot] = {}
        self._tasks: set[asyncio.Task] = set()
        self._sync_task: asyncio.Task | None = None
        self._synced_at = float("-inf")
        self._closed = False

    def group(self, group_id: str) -> GroupBot:
        return self.groups.setdefault(group_id, GroupBot())

    def is_running(self, group_id: str) -> bool:
        gb = self.groups.get(group_id)
        return gb is not None and gb.status == "running"

    def running(self) -> int:
        return sum(gb.status == "running" for gb in self.groups.values())

    # Selections ---------------------------------------------------------------------------

    def maybe_sync(self) -> None:
        """Called every tick: picks up changed selections and restarts that are due."""
        if self._closed or (self._sync_task is not None and not self._sync_task.done()):
            return
        if time.monotonic() - self._synced_at >= SYNC_EVERY_S:
            self._sync_task = self._spawn(self.sync())

    async def sync(self, wait: float = 0.0) -> None:
        """Starts, replaces or stops bots to match each group's active submission. With ``wait``,
        waits up to that long for the bots it starts."""
        self._synced_at = time.monotonic()
        if self._closed:
            return
        try:
            rows = await self.store.lobby_selections(self.runner.lobby_id)
        except Exception:
            log.exception("could not load active submissions for %s", self.runner.lobby_id)
            return
        wanted: dict[str, str | None] = {}
        for row in rows:
            self.runner.groups.setdefault(row["group_id"], row["name"])
            wanted[row["group_id"]] = row["submission_id"]
        started = []
        now = time.monotonic()
        for gid in set(self.groups) | set(wanted):
            gb = self.group(gid)
            sid = wanted.get(gid)
            if sid != gb.wanted or gb.reload:
                gb.wanted, gb.reload = sid, False
                started.append(self._spawn(self._select(gid, gb, sid)))
            elif gb.status == "stopped" and gb.restart_at is not None and now >= gb.restart_at:
                started.append(self._spawn(self._launch(gid, gb)))
        if wait and started:
            await asyncio.wait(started, timeout=wait)

    async def _select(self, gid: str, gb: GroupBot, sid: str | None) -> None:
        if self._closed:
            return
        gen = self._stop(gid, gb)
        retrying = gb.selection is not None and gb.selection.submission_id == sid
        gb.selection = None
        if sid is None:
            self._set_status(gid, gb, "none")
            return
        if not retrying:  # a retry (e.g. for a missing build) keeps its message meanwhile
            self._set_status(gid, gb, "starting")
        try:
            sub = await self.store.submission(sid)
            native = sub is not None and sub["language"] in NATIVE
            wasm = await self.store.bot_build(gid, sid) if native else None
        except Exception:
            log.exception("could not load submission %s", sid)
            if gen == gb.generation:
                gb.reload = True
                self._set_status(gid, gb, "stopped", "Couldn't load your submission; retrying.")
            return
        if gen != gb.generation:
            return
        if sub is None:
            self._set_status(gid, gb, "stopped", "Your active submission no longer exists.")
            return
        gb.selection = Selection(sid, sub["title"], sub["language"], sub["source"], wasm)
        gb.crashes = 0
        if native and wasm is None:
            gb.reload = True  # the build may still be uploading
            self._set_status(
                gid,
                gb,
                "stopped",
                "This C/C++ submission has no compiled build. Open it in Code & backtest and "
                "save it again.",
            )
            return
        await self._launch(gid, gb)

    async def _launch(self, gid: str, gb: GroupBot) -> None:
        sel = gb.selection
        if sel is None or self._closed:
            return
        gen = self._stop(gid, gb)
        self._set_status(gid, gb, "starting")
        bot = None
        try:
            bot = self.factory(sel.language, sel.source, sel.wasm, f"{gid[:8]}")
            gb.bot = bot
            logs = await bot.start()
        except Exception as exc:
            if gen != gb.generation:
                return
            gb.bot = None
            if isinstance(exc, BotError):
                self._console(gb, exc.logs, "log")
                self._console(gb, [str(exc)], "error")
            else:
                log.exception("could not start a bot for group %s", gid)
                self._console(gb, [f"The server couldn't start your bot: {exc}"], "error")
            self._set_status(
                gid,
                gb,
                "stopped",
                "Your bot didn't start (see the console). Fix it, save it and pick it again.",
            )
            return
        if gen != gb.generation:
            bot.close()
            return
        self._console(gb, logs, "log")
        self._set_status(gid, gb, "running")

    def _stop(self, gid: str, gb: GroupBot) -> int:
        """Stops the group's bot, if any; its resting orders shouldn't outlive it."""
        gb.generation += 1
        gb.restart_at = None
        if gb.bot is not None:
            gb.bot.close()
            gb.bot = None
            if not self._closed:
                self.runner.cancel_orders(gid)
        return gb.generation

    def _crashed(self, gid: str, gb: GroupBot, bot: Bot, reason: str) -> None:
        if gb.bot is not bot or self._closed:
            return
        self._stop(gid, gb)
        gb.crashes += 1
        delay = RESTART_DELAYS_S[min(gb.crashes, len(RESTART_DELAYS_S)) - 1]
        gb.restart_at = time.monotonic() + delay
        self._console(gb, [f"Your bot {reason}"], "error")
        headline = reason.splitlines()[0] if reason else "stopped"
        self._set_status(
            gid, gb, "stopped", f"Your bot {headline}. It restarts in {delay} s, with fresh memory."
        )

    # Ticks --------------------------------------------------------------------------------

    def send_states(self, t: int) -> None:
        """Hands each running bot its state for tick ``t``; replies arrive as tasks finish."""
        driver = self.runner.sim.driver
        for gid, gb in self.groups.items():
            bot = gb.bot
            if gb.status != "running" or bot is None:
                continue
            if bot.busy:
                self._missed(gb, t, "bot is still working on an earlier tick")
                continue
            self._spawn(self._tick(gid, gb, bot, t, bot_state(driver, gid)))

    async def _tick(self, gid: str, gb: GroupBot, bot: Bot, t: int, state: dict) -> None:
        started = time.perf_counter()
        try:
            reply = await bot.tick(state)
        except BotError as exc:
            self._crashed(gid, gb, bot, str(exc))
            return
        if gb.bot is not bot:
            return
        self._console(gb, reply.logs, "log")
        if reply.error is not None:  # run() raised: no orders this tick, like in a backtest
            self._console(gb, [f"tick {t}: {reply.error.rstrip()}"], "error")
            return
        notice = self.runner.submit_response(gid, t, reply.response)
        if notice is not None:
            self._missed(gb, t, notice)
            return
        gb.answered += 1
        gb.avg_ms += ((time.perf_counter() - started) * 1000 - gb.avg_ms) / gb.answered
        gb.crashes = 0

    async def after_close(self, t: int, open_log: TickLog, close_log: TickLog) -> None:
        """Records each group's fills and rejects for tick ``t`` and tells its monitors."""
        pushes = []
        for gid, gb in self.groups.items():
            msg = self.runner.result_message(gid, t, open_log, close_log)
            if msg["rejects"]:
                gb.rejects += len(msg["rejects"])
                self._console(gb, [f"tick {t}: rejected: {r}" for r in msg["rejects"]], "error")
            gb.fills.extendleft({**f, "tick": t} for f in msg["fills"])
            if gb.monitors:
                pushes.append(self._push(gb, {**msg, "stats": gb.stats()}))
        await asyncio.gather(*pushes)

    def _missed(self, gb: GroupBot, t: int, reason: str) -> None:
        gb.missed += 1
        self._console(gb, [f"tick {t}: skipped: {reason}"], "error")

    # Monitors -----------------------------------------------------------------------------

    async def add_monitor(self, group_id: str, ws: WebSocket) -> None:
        gb = self.group(group_id)
        await ws.send_json(self.snapshot(group_id))
        gb.monitors.add(ws)

    def remove_monitor(self, group_id: str, ws: WebSocket) -> None:
        gb = self.groups.get(group_id)
        if gb is not None:
            gb.monitors.discard(ws)

    def snapshot(self, group_id: str) -> dict:
        gb = self.group(group_id)
        r = self.runner
        return {
            "type": "snapshot",
            "status": r.status,
            "tick": r.tick,
            "end_tick": r.end_tick,
            "bot": gb.info(),
            "stats": gb.stats(),
            **r.account_summary(group_id),
            "fills": list(gb.fills),
            "console": list(gb.console),
        }

    async def broadcast(self, msg: dict) -> None:
        await asyncio.gather(*(self._push(gb, msg) for gb in self.groups.values()))

    async def close(self, code: int, reason: str) -> None:
        """Stops every bot and closes every monitor (the lobby finished or moved)."""
        self._closed = True
        for gid, gb in self.groups.items():
            self._stop(gid, gb)
        sockets = [ws for gb in self.groups.values() for ws in gb.monitors]
        for gb in self.groups.values():
            gb.monitors.clear()
        for ws in sockets:
            try:
                await ws.close(code=code, reason=reason)
            except Exception:
                pass

    def _console(self, gb: GroupBot, lines: list[str], kind: str) -> None:
        if not lines:
            return
        entries = [{"kind": kind, "text": line} for line in lines]
        gb.console.extend(entries)
        if gb.monitors:
            self._spawn(self._push(gb, {"type": "console", "lines": entries}))

    def _set_status(self, gid: str, gb: GroupBot, status: str, message: str | None = None) -> None:
        if (gb.status, gb.message) == (status, message):
            return
        gb.status, gb.message = status, message
        if not self._closed:  # the final leaderboard has no "online"
            self.runner._update_leaderboard()  # "online" follows the bot
        if gb.monitors:
            self._spawn(self._push(gb, {"type": "bot", "bot": gb.info()}))

    async def _push(self, gb: GroupBot, msg: dict) -> None:
        sockets = list(gb.monitors)
        sent = await asyncio.gather(*(_send(ws, msg) for ws in sockets))
        for ws, ok in zip(sockets, sent, strict=True):
            if not ok:
                gb.monitors.discard(ws)

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task


async def _send(ws: WebSocket, msg: dict) -> bool:
    try:
        await asyncio.wait_for(ws.send_json(msg), timeout=2)
        return True
    except Exception:
        return False
