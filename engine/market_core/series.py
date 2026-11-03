"""Replay a price-series round: one price per tick, every order fills at it. Browser-safe.

Some static rounds (e.g. "best time to buy and sell") publish a plain price path instead of
an order book. A marketable order fills in full at the tick's price, subject to the round's
position bounds; nothing rests. The interface matches ``Backtest`` and the
state has the live shape (the book shows the price on both sides), so every template and
runtime works unchanged. The round is published in full, so the state also carries
``prices``: every tick's price, past and future::

    bt = SeriesBacktest(manifest, events)
    while (state := bt.open_next()) is not None:
        summary = bt.close(<ask the bot with state>)
    bt.score()
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable

from .protocol import parse_bot_response
from .types import BUY, TIFS, NewOrder


class SeriesBacktest:
    def __init__(self, manifest: dict, events: Iterable[dict], owner: str = "you") -> None:
        rules = manifest["rules"]
        self.goods: list[str] = list(rules["goods"])
        self.max_positions: dict[str, int] = dict(rules["position_limits"])
        floors = rules.get("min_positions", {})
        self.min_positions = {g: floors.get(g, -self.max_positions[g]) for g in self.goods}
        self.owner = owner
        self.tick: int | None = None
        self.cash = 0
        self.position = {g: 0 for g in self.goods}
        events = list(events)
        self._events = iter(events)
        self._path = {g: tuple(int(e["prices"][g]) for e in events) for g in self.goods}
        self._prices: dict[str, int] = {}
        self._last_fills: list[dict] = []
        self._opened = 0  # ticks so far; history is every earlier tick's price

    def open_next(self) -> dict | None:
        event = next(self._events, None)
        if event is None:
            return None
        start = max(self._opened - 1, 0)  # the last tick's price is the only new one
        self._opened += 1
        self.tick = event["t"]
        self._prices = {g: int(event["prices"][g]) for g in self.goods}
        return {
            "tick": self.tick,
            "goods": list(self.goods),
            "limits": dict(self.max_positions),
            "min_positions": dict(self.min_positions),  # e.g. 0: you may not owe units
            "order_depths": {
                g: {"bids": [[p, self.max_positions[g]]], "asks": [[p, self.max_positions[g]]]}
                for g, p in self._prices.items()
            },
            "market_trades": {g: [] for g in self.goods},
            "position": dict(self.position),
            "cash": self.cash,
            "fees_paid": 0,
            "open_orders": [],
            "own_trades": [{**f, "maker": False} for f in self._last_fills],
            "prices": self._path,
            "history_start": start,
            "history": {g: p[start : self._opened - 1] for g, p in self._path.items()},
        }

    def close(self, response: object) -> dict:
        actions, rejects = parse_bot_response(self.owner, response)
        reasons = [r.reason for r in rejects]
        fills = []
        for action in actions:
            if not isinstance(action, NewOrder):
                continue  # nothing rests, so there is nothing to cancel
            reason = self._check(action)
            if reason is not None:
                reasons.append(reason)
                continue
            price = self._prices[action.good]
            signed = action.qty * action.side
            self.position[action.good] += signed
            self.cash -= signed * price
            fills.append({"good": action.good, "price": price, "qty": signed})
        self._last_fills = fills
        return {
            "tick": self.tick,
            "position": dict(self.position),
            "cash": self.cash,
            "pnl": self.score(),
            "fills": fills,
            "rejects": reasons,
        }

    def _check(self, a: NewOrder) -> str | None:
        if a.good not in self._prices:
            return "unknown good"
        if not isinstance(a.price, int) or isinstance(a.price, bool):
            return "price must be an integer"
        if a.tif not in TIFS:
            return "tif must be GTC or IOC"
        price = self._prices[a.good]
        if a.side == BUY and a.price < price:
            return "buy price is below this tick's price"
        if a.side != BUY and a.price > price:
            return "sell price is above this tick's price"
        after = self.position[a.good] + a.side * a.qty
        floor = self.min_positions[a.good]
        if after < floor:
            return "short selling is not allowed" if floor == 0 else "position limit"
        if after > self.max_positions[a.good]:
            return "position limit"
        return None

    def score(self) -> float:
        """Cash plus positions marked at the latest price."""
        return self.cash + sum(q * self._prices.get(g, 0) for g, q in self.position.items())

    def run(self, trader: Callable[[dict], object]) -> list[dict]:
        summaries = []
        while (state := self.open_next()) is not None:
            summaries.append(self.close(trader(state)))
        return summaries

    # JSON entry points for the Pyodide bridge.
    def open_next_json(self) -> str | None:
        state = self.open_next()
        return None if state is None else json.dumps(state)

    def close_json(self, response_json: str) -> str:
        return json.dumps(self.close(json.loads(response_json) if response_json else None))
