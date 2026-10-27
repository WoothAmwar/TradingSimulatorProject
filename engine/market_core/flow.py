"""Bot order flow. Server-only.

Every bot action is a function of the seed, the tick and the fair-value path alone — never of
the order book or of participant orders. That is what makes the published dataset a 1:1
prefix of the live market.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass

from .config import GoodConfig
from .models import make_process
from .rng import stream
from .types import BUY, SELL, Action, CancelAll, NewOrder


def _round(x: float) -> int:
    return int(math.floor(x + 0.5))


@dataclass(frozen=True)
class BotEvents:
    tick: int
    pre: list[Action]  # maker quote refresh, applied when the tick opens
    post: list[Action]  # noise and informed takers, applied after participants
    fair_values: dict[str, float]


class _GoodFlow:
    def __init__(self, cfg: GoodConfig, seed: int, index: int) -> None:
        self.cfg = cfg
        self.maker_owner = f"bot:mm:{cfg.name}"
        self._process = make_process(cfg.model, cfg.model_params, stream(seed, index, "fair_value"))
        self._maker_rng = stream(seed, index, "maker")
        self._noise_rng = stream(seed, index, "noise")
        self._informed_rng = stream(seed, index, "informed")
        # (value, vol) for ticks t .. t + horizon, so the informed trader can look ahead.
        self._path: deque[tuple[float, float]] = deque([(self._process.value, self._process.vol)])
        for _ in range(cfg.informed.horizon):
            self._advance()

    def _advance(self) -> None:
        self._process.step()
        self._path.append((self._process.value, self._process.vol))

    def events(self, pre: list[Action], post: list[Action]) -> float:
        cfg, good = self.cfg, self.cfg.name
        fv, vol = self._path[0]
        future_fv = self._path[-1][0]

        m = cfg.maker
        half = m.base_half_spread + m.vol_spread_mult * vol
        estimate = fv + self._maker_rng.normal(0.0, m.quote_noise) if m.quote_noise > 0 else fv
        bid = math.floor(estimate - half)
        ask = math.ceil(estimate + half)
        if ask <= bid:
            ask = bid + 1
        pre.append(CancelAll(self.maker_owner, good))
        for level in range(m.levels):
            bid_size = int(self._maker_rng.integers(m.size_min, m.size_max + 1))
            ask_size = int(self._maker_rng.integers(m.size_min, m.size_max + 1))
            bid_px = bid - level * m.level_step
            if bid_px >= 1:
                pre.append(NewOrder(self.maker_owner, good, BUY, bid_px, bid_size))
            pre.append(NewOrder(self.maker_owner, good, SELL, ask + level * m.level_step, ask_size))

        n = cfg.noise
        rng = self._noise_rng
        for _ in range(int(rng.poisson(n.rate))):
            side = BUY if rng.random() < 0.5 else SELL
            size = min(int(rng.geometric(n.size_p)), n.size_max)
            if rng.random() < n.take_prob:
                price = _round(fv + side * (half + n.take_reach))
                post.append(NewOrder("bot:noise", good, side, max(1, price), size, "IOC"))
            else:
                offset = rng.exponential(n.offset_mean)
                price = _round(fv - side * (1.0 + offset))
                post.append(NewOrder("bot:noise", good, side, max(1, price), size, "GTC", n.ttl))

        inf = cfg.informed
        rng = self._informed_rng
        if rng.random() < inf.prob:
            move = future_fv - fv
            size = min(int(rng.geometric(inf.size_p)), inf.size_max)
            if abs(move) >= inf.threshold:
                side = BUY if move > 0 else SELL
                # Willing to give up half of the expected move to get filled.
                price = _round(fv + move / 2)
                post.append(NewOrder("bot:informed", good, side, max(1, price), size, "IOC"))

        self._path.popleft()
        self._advance()
        return fv


class BotFlowGenerator:
    def __init__(self, goods: Sequence[GoodConfig], seed: int) -> None:
        self._goods = [_GoodFlow(cfg, seed, i) for i, cfg in enumerate(goods)]
        self._next_tick = 0

    def events(self, tick: int) -> BotEvents:
        if tick != self._next_tick:
            raise ValueError(
                f"bot flow must advance one tick at a time (expected {self._next_tick})"
            )
        self._next_tick += 1
        pre: list[Action] = []
        post: list[Action] = []
        fair_values = {flow.cfg.name: flow.events(pre, post) for flow in self._goods}
        return BotEvents(tick, pre, post, fair_values)
