"""Fair-value processes. Each exposes ``value`` and ``vol`` (per-tick std in price ticks)
for the current tick and ``step()`` to advance one tick."""

from __future__ import annotations

from typing import Protocol

import numpy as np

from .garch_jump import GarchJumpParams, GarchJumpProcess
from .ou import OUParams, OUProcess


class FairValueProcess(Protocol):
    value: float

    @property
    def vol(self) -> float: ...

    def step(self) -> float: ...


def make_process(model: str, params: dict, rng: np.random.Generator) -> FairValueProcess:
    if model == "ou":
        return OUProcess(OUParams(**params), rng)
    if model == "garch_jump":
        return GarchJumpProcess(GarchJumpParams(**params), rng)
    raise ValueError(f"unknown model {model!r}")


__all__ = [
    "FairValueProcess",
    "GarchJumpParams",
    "GarchJumpProcess",
    "OUParams",
    "OUProcess",
    "make_process",
]
