"""Limit order book for a single good with price-time priority."""

from __future__ import annotations

from bisect import bisect_left, insort
from collections import deque

from .types import BUY, SELL, Fill, Order


class OrderBook:
    def __init__(self, good: str) -> None:
        self.good = good
        self._levels: dict[int, dict[int, deque[Order]]] = {BUY: {}, SELL: {}}
        self._prices: dict[int, list[int]] = {BUY: [], SELL: []}  # ascending
        self._orders: dict[int, Order] = {}

    def __contains__(self, order_id: int) -> bool:
        return order_id in self._orders

    def get(self, order_id: int) -> Order | None:
        return self._orders.get(order_id)

    def best(self, side: int) -> int | None:
        prices = self._prices[side]
        if not prices:
            return None
        return prices[-1] if side == BUY else prices[0]

    def best_bid(self) -> int | None:
        return self.best(BUY)

    def best_ask(self) -> int | None:
        return self.best(SELL)

    def mid(self) -> float | None:
        bid, ask = self.best_bid(), self.best_ask()
        if bid is None or ask is None:
            return None
        return (bid + ask) / 2

    def rest(self, order: Order) -> None:
        levels = self._levels[order.side]
        level = levels.get(order.price)
        if level is None:
            level = levels[order.price] = deque()
            insort(self._prices[order.side], order.price)
        level.append(order)
        self._orders[order.id] = order

    def remove(self, order_id: int) -> Order | None:
        order = self._orders.pop(order_id, None)
        if order is None:
            return None
        level = self._levels[order.side][order.price]
        level.remove(order)
        if not level:
            self._drop_level(order.side, order.price)
        return order

    def match(self, taker: Order, tick: int) -> tuple[list[Fill], list[Order]]:
        """Fill ``taker`` against resting orders while prices cross; mutates ``taker.qty``.

        Returns the fills and any resting orders cancelled by self-trade prevention
        (a resting order owned by the taker is cancelled rather than traded against).
        """
        fills: list[Fill] = []
        self_cancelled: list[Order] = []
        opp = -taker.side
        while taker.qty > 0:
            best = self.best(opp)
            if best is None:
                break
            if (taker.side == BUY and best > taker.price) or (
                taker.side == SELL and best < taker.price
            ):
                break
            level = self._levels[opp][best]
            maker = level[0]
            if maker.owner == taker.owner:
                self.remove(maker.id)
                self_cancelled.append(maker)
                continue
            qty = min(taker.qty, maker.qty)
            maker.qty -= qty
            taker.qty -= qty
            if taker.side == BUY:
                buyer, seller = taker.owner, maker.owner
            else:
                buyer, seller = maker.owner, taker.owner
            fills.append(
                Fill(tick, self.good, best, qty, buyer, seller, taker.side, maker.id, taker.id)
            )
            if maker.qty == 0:
                level.popleft()
                del self._orders[maker.id]
                if not level:
                    self._drop_level(opp, best)
        return fills, self_cancelled

    def depth(self, levels: int | None = None) -> tuple[list[list[int]], list[list[int]]]:
        """Aggregated ``[price, qty]`` levels: bids best-first (descending), asks ascending."""
        bid_prices = self._prices[BUY][::-1]
        ask_prices = self._prices[SELL]
        if levels is not None:
            bid_prices, ask_prices = bid_prices[:levels], ask_prices[:levels]
        bids = [[p, sum(o.qty for o in self._levels[BUY][p])] for p in bid_prices]
        asks = [[p, sum(o.qty for o in self._levels[SELL][p])] for p in ask_prices]
        return bids, asks

    def _drop_level(self, side: int, price: int) -> None:
        del self._levels[side][price]
        prices = self._prices[side]
        del prices[bisect_left(prices, price)]
