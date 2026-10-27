"""Seeded random streams. Server-only: the lobby seed must never reach clients.

Every (good, process) pair gets an independent PCG64DXSM stream derived from the lobby seed
with ``SeedSequence`` spawn keys, so adding a good or a bot type never perturbs the others.
NumPy is pinned in ``uv.lock``; distribution methods are only stable within a NumPy version.
"""

from __future__ import annotations

import secrets

import numpy as np

STREAMS = {"fair_value": 0, "maker": 1, "noise": 2, "informed": 3}


def new_seed() -> int:
    return secrets.randbits(128)


def stream(seed: int, good_index: int, name: str) -> np.random.Generator:
    seq = np.random.SeedSequence(entropy=seed, spawn_key=(good_index, STREAMS[name]))
    return np.random.Generator(np.random.PCG64DXSM(seq))


def order_salt(seed: int) -> bytes:
    """Key for the per-tick participant ordering, derived so it reveals nothing about the seed."""
    seq = np.random.SeedSequence(entropy=seed, spawn_key=(2**32 - 1,))
    return seq.generate_state(8, dtype=np.uint64).tobytes()
