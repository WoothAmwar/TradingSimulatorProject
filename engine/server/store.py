"""Persistence. ``RestStore`` talks to Supabase (PostgREST + Storage) with the secret key, which
bypasses RLS; ``MemoryStore`` backs the tests and offline development."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

PAGE = 1000  # PostgREST's default max rows per request


@dataclass
class LobbyRecord:
    id: str
    name: str
    status: str
    public_config: dict
    current_tick: int | None
    max_groups: int


class Store(Protocol):
    async def is_admin(self, user_id: str) -> bool: ...
    async def user_group(self, user_id: str) -> str | None: ...
    async def load_lobby(self, lobby_id: str) -> LobbyRecord | None: ...
    async def load_secret(self, lobby_id: str) -> tuple[int, dict]: ...
    async def lobby_groups(self, lobby_id: str) -> dict[str, str]: ...
    async def lobbies_with_status(self, statuses: list[str]) -> list[str]: ...
    async def update_lobby(self, lobby_id: str, fields: dict) -> None: ...
    async def save_dataset(
        self, lobby_id: str, files: dict[str, bytes], manifest: dict
    ) -> None: ...
    async def order_batches(self, lobby_id: str) -> list[dict]: ...
    async def market_history(self, lobby_id: str) -> list[dict]: ...
    async def results(self, lobby_id: str) -> list[dict]: ...
    async def insert(self, table: str, rows: list[dict]) -> None: ...
    async def replace_results(self, lobby_id: str, rows: list[dict]) -> None: ...
    async def claim_lease(self, lobby_id: str, holder: str, ttl_seconds: int) -> bool: ...
    async def release_lease(self, lobby_id: str, holder: str) -> None: ...
    async def close(self) -> None: ...


class RestStore:
    def __init__(self, supabase_url: str, secret_key: str) -> None:
        # The gateway turns an sb_secret_ apikey into service-role authorization.
        self._http = httpx.AsyncClient(
            base_url=supabase_url, headers={"apikey": secret_key}, timeout=15
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def _get(self, table: str, params: dict[str, str]) -> list[dict]:
        rows: list[dict] = []
        while True:
            page = {**params, "limit": str(PAGE), "offset": str(len(rows))}
            res = await self._http.get(f"/rest/v1/{table}", params=page)
            res.raise_for_status()
            batch = res.json()
            rows.extend(batch)
            if len(batch) < PAGE:
                return rows

    async def _rpc(self, fn: str, args: dict) -> Any:
        res = await self._http.post(f"/rest/v1/rpc/{fn}", json=args)
        res.raise_for_status()
        return res.json() if res.content else None

    async def is_admin(self, user_id: str) -> bool:
        rows = await self._get("profiles", {"select": "is_admin", "id": f"eq.{user_id}"})
        return bool(rows and rows[0]["is_admin"])

    async def user_group(self, user_id: str) -> str | None:
        rows = await self._get("group_members", {"select": "group_id", "user_id": f"eq.{user_id}"})
        return rows[0]["group_id"] if rows else None

    async def load_lobby(self, lobby_id: str) -> LobbyRecord | None:
        rows = await self._get(
            "lobbies",
            {
                "select": "id,name,status,public_config,current_tick,max_groups",
                "id": f"eq.{lobby_id}",
            },
        )
        return LobbyRecord(**rows[0]) if rows else None

    async def load_secret(self, lobby_id: str) -> tuple[int, dict]:
        rows = await self._get(
            "lobby_secrets", {"select": "seed::text,model_config", "lobby_id": f"eq.{lobby_id}"}
        )
        if not rows:
            raise LookupError("lobby has no secrets row")
        return int(rows[0]["seed"]), rows[0]["model_config"]

    async def lobby_groups(self, lobby_id: str) -> dict[str, str]:
        rows = await self._get(
            "lobby_entries", {"select": "group_id,groups(name)", "lobby_id": f"eq.{lobby_id}"}
        )
        return {r["group_id"]: r["groups"]["name"] for r in rows}

    async def lobbies_with_status(self, statuses: list[str]) -> list[str]:
        rows = await self._get("lobbies", {"select": "id", "status": f"in.({','.join(statuses)})"})
        return [r["id"] for r in rows]

    async def update_lobby(self, lobby_id: str, fields: dict) -> None:
        res = await self._http.patch(
            "/rest/v1/lobbies", params={"id": f"eq.{lobby_id}"}, json=fields
        )
        res.raise_for_status()

    async def save_dataset(self, lobby_id: str, files: dict[str, bytes], manifest: dict) -> None:
        types = {".gz": "application/gzip", ".csv": "text/csv", ".json": "application/json"}
        for name, data in files.items():
            content_type = next((t for ext, t in types.items() if name.endswith(ext)), "")
            res = await self._http.post(
                f"/storage/v1/object/datasets/{lobby_id}/{name}",
                content=data,
                headers={
                    "x-upsert": "true",
                    "content-type": content_type or "application/octet-stream",
                },
            )
            res.raise_for_status()
        res = await self._http.post(
            "/rest/v1/datasets",
            json={"lobby_id": lobby_id, "ticks": manifest["ticks"], "manifest": manifest},
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        res.raise_for_status()

    async def order_batches(self, lobby_id: str) -> list[dict]:
        return await self._get(
            "order_batches",
            {
                "select": "tick,group_id,actions",
                "lobby_id": f"eq.{lobby_id}",
                "order": "tick,group_id",
            },
        )

    async def market_history(self, lobby_id: str) -> list[dict]:
        return await self._get(
            "market_snapshots",
            {"select": "tick,good,mid", "lobby_id": f"eq.{lobby_id}", "order": "tick"},
        )

    async def results(self, lobby_id: str) -> list[dict]:
        return await self._get(
            "lobby_results",
            {
                "select": "group_id,final_pnl,rank,groups(name)",
                "lobby_id": f"eq.{lobby_id}",
                "order": "rank",
            },
        )

    async def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        res = await self._http.post(
            f"/rest/v1/{table}",
            json=rows,
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )
        res.raise_for_status()

    async def replace_results(self, lobby_id: str, rows: list[dict]) -> None:
        res = await self._http.delete(
            "/rest/v1/lobby_results", params={"lobby_id": f"eq.{lobby_id}"}
        )
        res.raise_for_status()
        await self.insert("lobby_results", rows)

    async def claim_lease(self, lobby_id: str, holder: str, ttl_seconds: int) -> bool:
        return bool(
            await self._rpc(
                "claim_lobby_lease",
                {"p_lobby": lobby_id, "p_holder": holder, "p_ttl_seconds": ttl_seconds},
            )
        )

    async def release_lease(self, lobby_id: str, holder: str) -> None:
        await self._rpc("release_lobby_lease", {"p_lobby": lobby_id, "p_holder": holder})


@dataclass
class MemoryStore:
    admins: set[str] = field(default_factory=set)
    members: dict[str, str] = field(default_factory=dict)  # user -> group
    group_names: dict[str, str] = field(default_factory=dict)
    lobbies: dict[str, LobbyRecord] = field(default_factory=dict)
    secrets: dict[str, tuple[int, dict]] = field(default_factory=dict)
    entries: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    datasets: dict[str, tuple[dict[str, bytes], dict]] = field(default_factory=dict)
    tables: dict[str, list[dict]] = field(default_factory=lambda: defaultdict(list))
    results_rows: dict[str, list[dict]] = field(default_factory=dict)
    leases: dict[str, str] = field(default_factory=dict)

    async def close(self) -> None:
        pass

    async def is_admin(self, user_id: str) -> bool:
        return user_id in self.admins

    async def user_group(self, user_id: str) -> str | None:
        return self.members.get(user_id)

    async def load_lobby(self, lobby_id: str) -> LobbyRecord | None:
        return self.lobbies.get(lobby_id)

    async def load_secret(self, lobby_id: str) -> tuple[int, dict]:
        return self.secrets[lobby_id]

    async def lobby_groups(self, lobby_id: str) -> dict[str, str]:
        return {g: self.group_names[g] for g in self.entries[lobby_id]}

    async def lobbies_with_status(self, statuses: list[str]) -> list[str]:
        return [lid for lid, lobby in self.lobbies.items() if lobby.status in statuses]

    async def update_lobby(self, lobby_id: str, fields: dict) -> None:
        lobby = self.lobbies[lobby_id]
        for key, value in fields.items():
            if hasattr(lobby, key):
                setattr(lobby, key, value)

    async def save_dataset(self, lobby_id: str, files: dict[str, bytes], manifest: dict) -> None:
        self.datasets[lobby_id] = (files, manifest)

    async def order_batches(self, lobby_id: str) -> list[dict]:
        rows = [r for r in self.tables["order_batches"] if r["lobby_id"] == lobby_id]
        return sorted(rows, key=lambda r: (r["tick"], r["group_id"]))

    async def market_history(self, lobby_id: str) -> list[dict]:
        return [r for r in self.tables["market_snapshots"] if r["lobby_id"] == lobby_id]

    async def results(self, lobby_id: str) -> list[dict]:
        return [
            {**r, "groups": {"name": self.group_names.get(r["group_id"], "?")}}
            for r in self.results_rows.get(lobby_id, [])
        ]

    async def insert(self, table: str, rows: list[dict]) -> None:
        self.tables[table].extend(rows)

    async def replace_results(self, lobby_id: str, rows: list[dict]) -> None:
        self.results_rows[lobby_id] = rows

    async def claim_lease(self, lobby_id: str, holder: str, ttl_seconds: int) -> bool:
        current = self.leases.setdefault(lobby_id, holder)
        return current == holder

    async def release_lease(self, lobby_id: str, holder: str) -> None:
        if self.leases.get(lobby_id) == holder:
            del self.leases[lobby_id]
