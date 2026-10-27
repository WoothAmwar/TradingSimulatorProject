"""Replay a published dataset for one participant. Browser-safe (runs in Pyodide).

The JavaScript backtester drives this one tick at a time so that bots written in any
language can respond in between::

    bt = Backtest(manifest, events)
    while (state := bt.open_next()) is not None:
        response = <ask the bot with state>
        summary = bt.close(response)
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable

from .driver import TickDriver
from .exchange import ExchangeRules
from .protocol import bot_state, parse_bot_response
from .types import action_from_dict


class Backtest:
    def __init__(self, manifest: dict, events: Iterable[dict], owner: str = "you") -> None:
        self.rules = ExchangeRules.from_dict(manifest["rules"])
        self.driver = TickDriver(self.rules, b"", manifest.get("depth_levels", 10))
        self.owner = owner
        self._events = iter(events)
        self._post: list = []
        self._marks: dict[str, float] = {}

    def open_next(self) -> dict | None:
        event = next(self._events, None)
        if event is None:
            return None
        self.driver.open_tick(event["t"], [action_from_dict(a) for a in event["pre"]])
        self._post = [action_from_dict(a) for a in event["post"]]
        return bot_state(self.driver, self.owner)

    def close(self, response: object) -> dict:
        actions, rejects = parse_bot_response(self.owner, response)
        batches = {self.owner: actions} if actions else {}
        log = self.driver.close_tick(batches, self._post)
        for good, book in self.driver.exchange.books.items():
            mid = book.mid()
            if mid is not None:
                self._marks[good] = mid
        acct = self.driver.exchange.account(self.owner)
        position = {g: acct.position.get(g, 0) for g in self.rules.goods}
        pnl = acct.cash + sum(q * self._marks.get(g, 0.0) for g, q in position.items())
        rejects += [r for r in log.rejects if r.owner == self.owner]
        return {
            "tick": self.driver.tick,
            "position": position,
            "cash": acct.cash,
            "pnl": pnl,
            "fills": [
                {
                    "good": f.good,
                    "price": f.price,
                    "qty": f.qty if f.buyer == self.owner else -f.qty,
                }
                for f in log.fills
                if self.owner in (f.buyer, f.seller)
            ],
            "rejects": [r.reason for r in rejects],
        }

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
