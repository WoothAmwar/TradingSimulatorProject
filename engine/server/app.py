"""HTTP and WebSocket surface of the engine (served by ``server.main``)."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from .auth import AuthError, JwksVerifier, Verifier
from .bots import BotFactory, SandboxFactory
from .manager import EngineManager, LobbyError
from .settings import Settings
from .store import RestStore, Store

log = logging.getLogger("engine")

Action = Literal["prepare", "start", "pause", "resume", "stop"]


def create_app(
    store: Store, verifier: Verifier, settings: Settings, bot_factory: BotFactory | None = None
) -> FastAPI:
    manager = EngineManager(store, settings, bot_factory or SandboxFactory(settings.python_dir))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.startup()
        yield
        await manager.shutdown()

    app = FastAPI(title="ACM Trading Simulator engine", lifespan=lifespan)
    app.state.manager = manager

    async def require_admin(authorization: str = Header(default="")) -> str:
        token = authorization.removeprefix("Bearer ").strip()
        try:
            user_id = await verifier.verify(token)
        except AuthError as exc:
            raise HTTPException(401, "invalid or expired session") from exc
        if not await store.is_admin(user_id):
            raise HTTPException(403, "admins only")
        return user_id

    @app.get("/health")
    async def health() -> dict:
        return {
            "ok": True,
            "instance": settings.instance_id,
            "lobbies": {
                lobby_id: {"status": r.status, "tick": r.tick, "bots": r.bots.running()}
                for lobby_id, r in manager.runners.items()
            },
        }

    @app.post("/admin/lobbies/{lobby_id}/{action}")
    async def lobby_action(lobby_id: str, action: Action, _: str = Depends(require_admin)) -> dict:
        try:
            await getattr(manager, action)(lobby_id)
        except LobbyError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        return {"ok": True}

    @app.websocket("/ws/market/{lobby_id}")
    async def market_feed(ws: WebSocket, lobby_id: str) -> None:
        if not settings.origin_allowed(ws.headers.get("origin")):
            await ws.close(code=4003)
            return
        await ws.accept()
        runner = await manager.viewer_runner(lobby_id)
        try:
            if runner is None:
                snapshot = await manager.static_snapshot(lobby_id)
                if snapshot is None:
                    await ws.close(code=4404, reason="lobby not found")
                    return
                await ws.send_json(snapshot)
            else:
                await runner.add_viewer(ws)
            while True:  # viewers never send; this just detects the disconnect
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            if runner is not None:
                runner.viewers.discard(ws)

    @app.websocket("/ws/bot/{lobby_id}")
    async def bot_monitor(ws: WebSocket, lobby_id: str) -> None:
        """A group's view of its bot, which runs on the engine: status, console, fills, stats.
        Members watch their own group; admins may name any group with ``group_id``."""
        if not settings.origin_allowed(ws.headers.get("origin")):
            await ws.close(code=4003)
            return
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
            user_id = await verifier.verify(str(hello.get("token", "")))
        except (TimeoutError, AuthError, json.JSONDecodeError, AttributeError, WebSocketDisconnect):
            await _close(ws, 4401, "authentication failed")
            return
        group_id = await store.user_group(user_id)
        wanted = hello.get("group_id")
        if wanted and wanted != group_id:
            if not await store.is_admin(user_id):
                await _close(ws, 4403, "you can only watch your own group's bot")
                return
            group_id = str(wanted)
        if group_id is None:
            await _close(ws, 4403, "you are not in a group")
            return
        runner = await manager.viewer_runner(lobby_id)
        if runner is None and lobby_id in manager.recovering:
            # Still being rebuilt after a restart; 1013 isn't final, so the page reconnects.
            await _close(ws, 1013, "lobby is recovering; try again shortly")
            return
        if runner is None or runner.status == "finished":
            await _close(ws, 4404, "lobby is not live")
            return
        if group_id not in runner.groups:
            runner.groups = await store.lobby_groups(lobby_id)
            if group_id not in runner.groups:
                await _close(ws, 4403, "this group is not entered in this lobby")
                return

        await runner.bots.add_monitor(group_id, ws)
        try:
            while True:  # monitors only send keep-alives
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            runner.bots.remove_monitor(group_id, ws)

    return app


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    try:
        await ws.close(code=code, reason=reason)
    except Exception:
        pass


def app_from_env() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.from_env()
    return create_app(
        RestStore(settings.supabase_url, settings.supabase_secret_key),
        JwksVerifier(settings.supabase_url),
        settings,
    )
