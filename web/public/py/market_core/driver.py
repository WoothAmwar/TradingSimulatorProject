"""The per-tick protocol shared by the live engine and the backtester.

Each tick ``t`` runs in two halves:

1. ``open_tick(t, pre)``: expire orders, then apply the bot market maker's quote refresh.
   The resulting book is the state every participant bot sees for tick ``t``.
2. ``close_tick(batches, post)``: apply each participant's batch of actions (participants in a
   seeded order, each batch atomically in submission order), then the bot takers
   (noise and informed traders), which can fill against resting participant quotes.

Bot actions depend only on the seed and the tick, never on participant behaviour, so a
backtest that replays the recorded bot actions reproduces the live market exactly for a
single participant.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence

from .exchange import Exchange, ExchangeRules, TickLog
from .types import Action, Fill


class TickDriver:
    def __init__(self, rules: ExchangeRules, order_salt: bytes = b"", depth_levels: int = 10):
        self.rules = rules
        self.exchange = Exchange(rules)
        self.depth_levels = depth_levels
        self.tick: int | None = None
        self.recent_fills: list[Fill] = []  # fills shown in the current state
        self._salt = order_salt[:64]
        self._open = False
        self._close_fills: list[Fill] = []

    def open_tick(self, tick: int, pre: Iterable[Action]) -> TickLog:
        if self._open:
            raise RuntimeError("previous tick is still open")
        if self.tick is not None and tick != self.tick + 1:
            raise ValueError(f"expected tick {self.tick + 1}, got {tick}")
        log = TickLog()
        self.exchange.begin_tick(tick, log)
        for action in pre:
            self.exchange.apply(tick, action, log)
        self.recent_fills = self._close_fills + log.fills
        self.tick = tick
        self._open = True
        return log

    def close_tick(
        self, batches: Mapping[str, Sequence[Action]], post: Iterable[Action]
    ) -> TickLog:
        if not self._open:
            raise RuntimeError("no open tick")
        assert self.tick is not None
        log = TickLog()
        for owner in self.participant_order(self.tick, batches):
            for action in batches[owner]:
                if action.owner != owner:
                    raise ValueError(f"action owner {action.owner!r} in batch for {owner!r}")
                self.exchange.apply(self.tick, action, log)
        for action in post:
            self.exchange.apply(self.tick, action, log)
        self._close_fills = log.fills
        self._open = False
        return log

    def participant_order(self, tick: int, owners: Iterable[str]) -> list[str]:
        prefix = tick.to_bytes(8, "big")

        def key(owner: str) -> bytes:
            return hashlib.blake2b(prefix + owner.encode(), key=self._salt, digest_size=16).digest()

        return sorted(owners, key=key)

    def public_state(self) -> dict:
        depths = {}
        trades: dict[str, list[list[int]]] = {g: [] for g in self.rules.goods}
        for good, book in self.exchange.books.items():
            bids, asks = book.depth(self.depth_levels)
            depths[good] = {"bids": bids, "asks": asks}
        for fill in self.recent_fills:
            trades[fill.good].append([fill.price, fill.qty, fill.aggressor])
        return {"tick": self.tick, "order_depths": depths, "market_trades": trades}

    def private_state(self, owner: str) -> dict:
        acct = self.exchange.accounts.get(owner)
        position = {g: (acct.position.get(g, 0) if acct else 0) for g in self.rules.goods}
        own_trades = []
        for fill in self.recent_fills:
            if owner in (fill.buyer, fill.seller):
                signed = fill.qty if fill.buyer == owner else -fill.qty
                maker = (fill.buyer == owner) != (fill.aggressor == 1)
                own_trades.append(
                    {"good": fill.good, "price": fill.price, "qty": signed, "maker": maker}
                )
        open_orders = [
            {
                "id": o.id,
                "good": o.good,
                "price": o.price,
                "qty": o.qty * o.side,
                "tif": o.tif,
                "client_id": o.client_id,
            }
            for o in self.exchange.open_orders(owner)
        ]
        return {
            "position": position,
            "cash": acct.cash if acct else 0,
            "fees_paid": acct.fees_paid if acct else 0,
            "open_orders": open_orders,
            "own_trades": own_trades,
        }
