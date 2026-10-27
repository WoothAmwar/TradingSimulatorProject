"""Geometric Brownian motion with GARCH(1,1) volatility, Student-t shocks and Merton jumps.

Per tick, with conditional variance h_t:
    eps_t = sqrt(h_t) z_t,       z_t ~ standardized Student-t(nu)        (fat tails)
    J_t   = sum of N_t jumps,    N_t ~ Poisson(lambda), size ~ N(mu_J, sigma_J)
    log S_{t+1} = log S_t + drift - h_t / 2 + eps_t + J_t
    h_{t+1} = omega + alpha eps_t^2 + beta h_t                          (volatility clustering)
The unconditional variance is omega / (1 - alpha - beta).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GarchJumpParams:
    s0: float = 5_000.0
    drift: float = 0.0
    omega: float = 5e-9
    alpha: float = 0.08
    beta: float = 0.90
    nu: float = 4.0
    jump_rate: float = 0.002
    jump_mean: float = 0.0
    jump_std: float = 0.01


class GarchJumpProcess:
    def __init__(self, params: GarchJumpParams, rng: np.random.Generator) -> None:
        if params.alpha + params.beta >= 1:
            raise ValueError("alpha + beta must be < 1 for a stationary variance")
        if params.nu <= 2:
            raise ValueError("nu must be > 2 for a finite variance")
        self.params = params
        self._rng = rng
        self._t_scale = math.sqrt((params.nu - 2) / params.nu)
        self._var = params.omega / (1 - params.alpha - params.beta)
        self._log_s = math.log(params.s0)
        self.value = params.s0

    @property
    def vol(self) -> float:
        return math.sqrt(self._var) * self.value

    def step(self) -> float:
        p, rng = self.params, self._rng
        eps = math.sqrt(self._var) * rng.standard_t(p.nu) * self._t_scale
        jumps = int(rng.poisson(p.jump_rate))
        jump = (
            float(rng.normal(p.jump_mean * jumps, p.jump_std * math.sqrt(jumps))) if jumps else 0.0
        )
        self._log_s += p.drift - self._var / 2 + eps + jump
        self._var = p.omega + p.alpha * eps * eps + p.beta * self._var
        self.value = math.exp(self._log_s)
        return self.value
