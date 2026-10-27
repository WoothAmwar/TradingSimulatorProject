from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str
    allowed_origins: tuple[str, ...]  # empty = allow any (local development)
    instance_id: str
    lease_ttl_seconds: int = 20

    @classmethod
    def from_env(cls) -> Settings:
        origins = os.environ.get("ALLOWED_ORIGINS", "")
        return cls(
            supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
            supabase_secret_key=os.environ["SUPABASE_SECRET_KEY"],
            allowed_origins=tuple(o.strip().rstrip("/") for o in origins.split(",") if o.strip()),
            instance_id=os.environ.get("RENDER_INSTANCE_ID")
            or f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}",
        )

    def origin_allowed(self, origin: str | None) -> bool:
        if not self.allowed_origins:
            return True
        return origin is not None and origin.rstrip("/") in self.allowed_origins
