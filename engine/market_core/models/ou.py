"""Ornstein-Uhlenbeck mean reversion: dX = kappa (mu - X) dt + sigma dW.

Advanced with the exact discretization for dt = 1 tick:
X_{t+1} = mu + (X_t - mu) e^{-kappa} + sigma sqrt((1 - e^{-2 kappa}) / (2 kappa)) Z,  Z ~ N(0, 1).
Half-life of a deviation is ln 2 / kappa ticks; stationary std is sigma / sqrt(2 kappa).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class OUParams:
    mu: float = 10_000.0
    kappa: float = 0.01
    sigma: float = 1.5
    x0: float | None = None


class OUProcess:
    def __init__(self, params: OUParams, rng: np.random.Generator) -> None:
        if params.kappa <= 0:
            raise ValueError("kappa must be positive")
        self.params = params
        self._rng = rng
        self._decay = math.exp(-params.kappa)
        self._shock = params.sigma * math.sqrt(
            (1 - math.exp(-2 * params.kappa)) / (2 * params.kappa)
        )
        self.value = params.mu if params.x0 is None else params.x0

    @property
    def vol(self) -> float:
        return self._shock

    def step(self) -> float:
        p = self.params
        self.value = (
            p.mu + (self.value - p.mu) * self._decay + self._shock * self._rng.standard_normal()
        )
        return self.value
