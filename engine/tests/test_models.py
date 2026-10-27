"""Stylized facts the price models are meant to exhibit."""

import math

import numpy as np

from market_core.models import GarchJumpParams, GarchJumpProcess, OUParams, OUProcess


def test_ou_half_life_and_stationary_std():
    p = OUParams(mu=10_000, kappa=0.02, sigma=2.0)
    proc = OUProcess(p, np.random.default_rng(1))
    xs = np.array([proc.step() for _ in range(200_000)])
    dev = xs - p.mu
    phi = np.dot(dev[1:], dev[:-1]) / np.dot(dev[:-1], dev[:-1])
    assert abs(-math.log(phi) - p.kappa) < 0.003
    assert abs(dev.std() - p.sigma / math.sqrt(2 * p.kappa)) < 0.5
    assert abs(xs.mean() - p.mu) < 1.0


def log_returns(params: GarchJumpParams, n: int, seed: int) -> np.ndarray:
    proc = GarchJumpProcess(params, np.random.default_rng(seed))
    prices = np.array([params.s0] + [proc.step() for _ in range(n)])
    assert (prices > 0).all()
    return np.diff(np.log(prices))


def acf1(x: np.ndarray) -> float:
    x = x - x.mean()
    return float(np.dot(x[1:], x[:-1]) / np.dot(x, x))


def test_garch_jump_fat_tails():
    r = log_returns(GarchJumpParams(), 100_000, seed=2)
    z = (r - r.mean()) / r.std()
    assert (z**4).mean() - 3 > 1.0  # excess kurtosis: far fatter tails than a normal
    assert abs(acf1(r)) < 0.03  # returns themselves are close to unpredictable


def test_garch_volatility_clustering():
    r = log_returns(GarchJumpParams(jump_rate=0.0), 100_000, seed=3)
    assert acf1(np.abs(r)) > 0.05  # |returns| are autocorrelated: volatility clusters
