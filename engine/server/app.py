"""HTTP and WebSocket surface of the engine (served by ``server.main``)."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

from .auth import AuthError, JwksVerifier, Verifier
from .manager import EngineManager, LobbyError
from .runner import Trader
from .settings import Settings
from .store import RestStore, Store

log = logging.getLogger("engine")

Action = Literal["prepare", "start", "pause", "resume", "stop"]


def create_app(store: Store, verifier: Verifier, settings: Settings) -> FastAPI:
    manager = EngineManager(store, settings)

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
                lobby_id: {"status": r.status, "tick": r.tick, "traders": len(r.traders)}
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

    @app.websocket("/ws/trade/{lobby_id}")
    async def trade(ws: WebSocket, lobby_id: str) -> None:
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
        if group_id is None:
            await _close(ws, 4403, "you are not in a group")
            return
        runner = await manager.viewer_runner(lobby_id)
        if runner is None or runner.status == "finished":
            await _close(ws, 4404, "lobby is not open for trading")
            return
        if group_id not in runner.groups:
            runner.groups = await store.lobby_groups(lobby_id)
            if group_id not in runner.groups:
                await _close(ws, 4403, "your group is not entered in this lobby")
                return

        trader = Trader(group_id, user_id, ws)
        await runner.add_trader(trader)
        try:
            while True:
                try:
                    msg = await ws.receive_json()
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict):
                    notice = runner.handle_trader_message(group_id, msg)
                    if notice is not None:
                        await ws.send_json(notice)
        except WebSocketDisconnect:
            pass
        finally:
            runner.remove_trader(trader)

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
