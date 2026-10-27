"""Owns every lobby runner in this instance: admin actions, lease heartbeats, crash recovery."""

from __future__ import annotations

import asyncio
import logging
import tempfile
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from market_core.config import resolve_lobby_config
from market_core.dataset import build_dataset

from .runner import LobbyRunner
from .settings import Settings
from .store import LobbyRecord, Store

log = logging.getLogger("engine.manager")


class LobbyError(Exception):
    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


class EngineManager:
    def __init__(self, store: Store, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        self.runners: dict[str, LobbyRunner] = {}
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._background: set[asyncio.Task] = set()

    # Lifecycle ----------------------------------------------------------------------------

    async def startup(self) -> None:
        self._spawn(self._heartbeat())
        self._spawn(self.recover())

    async def shutdown(self) -> None:
        for task in self._background:
            task.cancel()
        for lobby_id, runner in list(self.runners.items()):
            if runner.status in ("running", "paused"):
                await runner.detach()
                await self.store.release_lease(lobby_id, self.settings.instance_id)
        await self.store.close()

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _heartbeat(self) -> None:
        interval = self.settings.lease_ttl_seconds / 3
        while True:
            await asyncio.sleep(interval)
            for lobby_id, runner in list(self.runners.items()):
                if runner.status not in ("running", "paused"):
                    continue
                try:
                    held = await self._claim(lobby_id)
                except Exception:
                    log.exception("lease renewal failed for %s", lobby_id)
                    continue
                if not held:
                    log.warning("lost lease for %s; detaching", lobby_id)
                    await runner.detach()
                    self.runners.pop(lobby_id, None)

    async def _claim(self, lobby_id: str) -> bool:
        return await self.store.claim_lease(
            lobby_id, self.settings.instance_id, self.settings.lease_ttl_seconds
        )

    async def recover(self) -> None:
        """Resumes lobbies that were running when the previous instance stopped."""
        try:
            lobby_ids = await self.store.lobbies_with_status(["running", "paused"])
        except Exception:
            log.exception("could not list lobbies to recover")
            return
        for lobby_id in lobby_ids:
            self._spawn(self._recover_one(lobby_id))

    async def _recover_one(self, lobby_id: str) -> None:
        # During a deploy the old instance holds the lease until it shuts down.
        for _ in range(90):
            if await self._claim(lobby_id):
                break
            await asyncio.sleep(2)
        else:
            log.warning("could not acquire lease for %s; another instance runs it", lobby_id)
            return
        async with self._locks[lobby_id]:
            lobby = await self.store.load_lobby(lobby_id)
            if lobby is None or lobby.status not in ("running", "paused"):
                await self.store.release_lease(lobby_id, self.settings.instance_id)
                return
            runner = await self._build(lobby, replay=True)
            runner.status = lobby.status
            runner.start()
            log.info("recovered lobby %s at tick %s (%s)", lobby_id, runner.sim.tick, lobby.status)

    # Runners ------------------------------------------------------------------------------

    async def _build(self, lobby: LobbyRecord, replay: bool = False) -> LobbyRunner:
        seed, model = await self.store.load_secret(lobby.id)
        config = resolve_lobby_config(lobby.public_config, model)
        groups = await self.store.lobby_groups(lobby.id)
        runner = LobbyRunner(lobby.id, config, seed, groups, self.store, lobby.status)
        batches: dict[int, dict[str, list[dict]]] = defaultdict(dict)
        until = None
        if replay:
            for row in await self.store.order_batches(lobby.id):
                batches[row["tick"]][row["group_id"]] = row["actions"]
            last = max(batches, default=config.dataset_ticks - 1)
            until = max(lobby.current_tick or config.dataset_ticks, last + 1)
        await asyncio.to_thread(runner.prepare, batches, until)
        runner.on_finished = self._on_finished
        self.runners[lobby.id] = runner
        return runner

    async def _on_finished(self, runner: LobbyRunner) -> None:
        await self.store.release_lease(runner.lobby_id, self.settings.instance_id)

    async def viewer_runner(self, lobby_id: str) -> LobbyRunner | None:
        """A runner to stream from: the live one, or a preview of a scheduled lobby."""
        runner = self.runners.get(lobby_id)
        if runner is not None:
            return runner
        async with self._locks[lobby_id]:
            if lobby_id in self.runners:
                return self.runners[lobby_id]
            lobby = await self.store.load_lobby(lobby_id)
            if lobby is None or lobby.status != "scheduled":
                return None
            return await self._build(lobby)

    async def static_snapshot(self, lobby_id: str) -> dict | None:
        """For lobbies without a runner here: finished ones (from the database) or ones that
        another instance is running."""
        lobby = await self.store.load_lobby(lobby_id)
        if lobby is None or lobby.status == "draft":
            return None
        history: dict[str, list[list[float]]] = defaultdict(list)
        leaderboard: list[dict] = []
        if lobby.status == "finished":
            for row in await self.store.market_history(lobby_id):
                if row["mid"] is not None:
                    history[row["good"]].append([row["tick"], float(row["mid"])])
            leaderboard = [
                {
                    "group_id": r["group_id"],
                    "name": r["groups"]["name"],
                    "pnl": float(r["final_pnl"]),
                }
                for r in await self.store.results(lobby_id)
            ]
        return {
            "type": "snapshot",
            "status": lobby.status,
            "tick": lobby.current_tick,
            "tick_ms": lobby.public_config.get("tick_ms", 1000),
            "goods": lobby.public_config.get("goods", []),
            "history": history,
            "books": {},
            "leaderboard": leaderboard,
        }

    # Admin actions ------------------------------------------------------------------------

    async def _lobby(self, lobby_id: str, allowed: tuple[str, ...]) -> LobbyRecord:
        lobby = await self.store.load_lobby(lobby_id)
        if lobby is None:
            raise LobbyError("lobby not found", 404)
        if lobby.status not in allowed:
            raise LobbyError(f"lobby is {lobby.status}; expected {' or '.join(allowed)}")
        return lobby

    async def prepare(self, lobby_id: str) -> None:
        """Builds the public dataset (ticks 0..K-1), uploads it and publishes the lobby."""
        async with self._locks[lobby_id]:
            lobby = await self._lobby(lobby_id, ("draft", "scheduled"))
            seed, model = await self.store.load_secret(lobby_id)
            try:
                config = resolve_lobby_config(lobby.public_config, model)
            except ValueError as exc:
                raise LobbyError(str(exc), 400) from exc
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                manifest = await asyncio.to_thread(build_dataset, config, seed, out)
                files = {name: (out / name).read_bytes() for name in manifest["files"]}
                files["manifest.json"] = (out / "manifest.json").read_bytes()
            await self.store.save_dataset(lobby_id, files, manifest)
            public = {
                **lobby.public_config,
                "goods": [g.name for g in config.goods],
                "tick_ms": config.tick_ms,
                "dataset_ticks": config.dataset_ticks,
                "live_ticks": config.live_ticks,
                "depth_levels": config.depth_levels,
                "rules": config.rules().to_dict(),
            }
            await self.store.update_lobby(
                lobby_id, {"public_config": public, "status": "scheduled"}
            )
            self.runners.pop(lobby_id, None)  # previews must pick up the new config

    async def start(self, lobby_id: str) -> None:
        async with self._locks[lobby_id]:
            lobby = await self._lobby(lobby_id, ("scheduled",))
            if not await self._claim(lobby_id):
                raise LobbyError("another engine instance holds this lobby")
            runner = self.runners.get(lobby_id) or await self._build(lobby)
            runner.groups = await self.store.lobby_groups(lobby_id)
            runner._update_leaderboard()
            await self.store.update_lobby(
                lobby_id,
                {
                    "status": "running",
                    "started_at": datetime.now(UTC).isoformat(),
                    "current_tick": runner.sim.tick,
                },
            )
            runner.start()
            await runner._broadcast({"type": "status", "status": "running", "tick": runner.tick})

    def _live_runner(self, lobby_id: str, statuses: tuple[str, ...]) -> LobbyRunner:
        runner = self.runners.get(lobby_id)
        if runner is None or runner.status not in statuses:
            raise LobbyError(f"lobby is not {' or '.join(statuses)} on this engine instance")
        return runner

    async def pause(self, lobby_id: str) -> None:
        runner = self._live_runner(lobby_id, ("running",))
        await runner.pause()
        await self.store.update_lobby(lobby_id, {"status": "paused"})

    async def resume(self, lobby_id: str) -> None:
        runner = self._live_runner(lobby_id, ("paused",))
        await runner.resume()
        await self.store.update_lobby(lobby_id, {"status": "running"})

    async def stop(self, lobby_id: str) -> None:
        runner = self._live_runner(lobby_id, ("running", "paused"))
        await runner.stop()
