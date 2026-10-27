"""Verifies Supabase access tokens against the project's JWKS (asymmetric signing keys)."""

from __future__ import annotations

import asyncio
from typing import Protocol

import jwt


class AuthError(Exception):
    pass


class Verifier(Protocol):
    async def verify(self, token: str) -> str:
        """Returns the user id (``sub``) or raises :class:`AuthError`."""
        ...


class JwksVerifier:
    def __init__(self, supabase_url: str) -> None:
        self.issuer = f"{supabase_url}/auth/v1"
        self._jwks = jwt.PyJWKClient(f"{self.issuer}/.well-known/jwks.json", lifespan=3600)

    async def verify(self, token: str) -> str:
        try:
            key = await asyncio.to_thread(self._jwks.get_signing_key_from_jwt, token)
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
                issuer=self.issuer,
            )
        except jwt.PyJWTError as exc:
            raise AuthError(str(exc)) from exc
        sub = claims.get("sub")
        if not sub:
            raise AuthError("token has no subject")
        return sub
