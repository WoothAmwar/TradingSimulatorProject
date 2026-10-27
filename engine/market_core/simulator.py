"""Seeded market: bot order flow driving the shared tick protocol. Server-only."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from .config import LobbyConfig
from .driver import TickDriver
from .exchange import TickLog
from .flow import BotEvents, BotFlowGenerator
from .rng import order_salt
from .types import Action


class MarketSimulator:
    def __init__(self, config: LobbyConfig, seed: int) -> None:
        self.config = config
        self.driver = TickDriver(config.rules(), order_salt(seed), config.depth_levels)
        self._flow = BotFlowGenerator(config.goods, seed)
        self.tick = 0  # next tick to open
        self.current: BotEvents | None = None

    @property
    def fair_values(self) -> dict[str, float]:
        return self.current.fair_values if self.current else {}

    def open_tick(self) -> TickLog:
        self.current = self._flow.events(self.tick)
        return self.driver.open_tick(self.tick, self.current.pre)

    def close_tick(self, batches: Mapping[str, Sequence[Action]] | None = None) -> TickLog:
        assert self.current is not None
        log = self.driver.close_tick(batches or {}, self.current.post)
        self.tick += 1
        return log

    def fast_forward(self, until_tick: int) -> None:
        """Run bot-only ticks up to (not including) ``until_tick``."""
        while self.tick < until_tick:
            self.open_tick()
            self.close_tick()
