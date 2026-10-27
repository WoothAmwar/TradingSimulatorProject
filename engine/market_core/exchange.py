"""Multi-good exchange: risk checks, matching, accounting and order expiry."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .book import OrderBook
from .types import (
    BUY,
    SELL,
    TIFS,
    Ack,
    Action,
    Cancel,
    CancelAll,
    Fill,
    NewOrder,
    Order,
    Reject,
    is_bot,
)


@dataclass(frozen=True)
class ExchangeRules:
    goods: tuple[str, ...]
    position_limits: dict[str, int]
    max_orders_per_tick: int = 20
    max_open_orders: int = 50
    maker_fee: int = 0  # cash per unit, charged to participants only (negative = rebate)
    taker_fee: int = 0
    max_price: int = 10_000_000

    def to_dict(self) -> dict:
        return {
            "goods": list(self.goods),
            "position_limits": dict(self.position_limits),
            "max_orders_per_tick": self.max_orders_per_tick,
            "max_open_orders": self.max_open_orders,
            "maker_fee": self.maker_fee,
            "taker_fee": self.taker_fee,
            "max_price": self.max_price,
        }

    @classmethod
    def from_dict(cls, d: dict) -> ExchangeRules:
        return cls(
            goods=tuple(d["goods"]),
            position_limits=dict(d["position_limits"]),
            max_orders_per_tick=d.get("max_orders_per_tick", 20),
            max_open_orders=d.get("max_open_orders", 50),
            maker_fee=d.get("maker_fee", 0),
            taker_fee=d.get("taker_fee", 0),
            max_price=d.get("max_price", 10_000_000),
        )


@dataclass
class Account:
    owner: str
    cash: int = 0
    position: dict[str, int] = field(default_factory=dict)
    fees_paid: int = 0


@dataclass
class TickLog:
    fills: list[Fill] = field(default_factory=list)
    acks: list[Ack] = field(default_factory=list)
    rejects: list[Reject] = field(default_factory=list)
    cancelled: list[Order] = field(default_factory=list)  # cancels, expiries and self-trade cancels

    def extend(self, other: TickLog) -> None:
        self.fills.extend(other.fills)
        self.acks.extend(other.acks)
        self.rejects.extend(other.rejects)
        self.cancelled.extend(other.cancelled)


class Exchange:
    def __init__(self, rules: ExchangeRules) -> None:
        self.rules = rules
        self.books = {g: OrderBook(g) for g in rules.goods}
        self.accounts: dict[str, Account] = {}
        self._next_id = 1
        self._open: dict[str, dict[int, Order]] = defaultdict(dict)  # owner -> resting orders
        self._open_qty: Counter[tuple[str, str, int]] = Counter()  # (owner, good, side) -> qty
        self._expiry: dict[int, list[int]] = defaultdict(list)
        self._new_this_tick: Counter[str] = Counter()

    def account(self, owner: str) -> Account:
        acct = self.accounts.get(owner)
        if acct is None:
            acct = self.accounts[owner] = Account(owner)
        return acct

    def open_orders(self, owner: str) -> list[Order]:
        return sorted(self._open.get(owner, {}).values(), key=lambda o: o.id)

    def begin_tick(self, tick: int, log: TickLog) -> None:
        """Reset per-tick rate limits and expire orders whose time is up."""
        self._new_this_tick.clear()
        for order_id in self._expiry.pop(tick, ()):
            for book in self.books.values():
                if order_id in book:
                    order = book.remove(order_id)
                    assert order is not None
                    self._forget(order)
                    log.cancelled.append(order)
                    break

    def apply(self, tick: int, action: Action, log: TickLog) -> None:
        if isinstance(action, NewOrder):
            self._new_order(tick, action, log)
        elif isinstance(action, Cancel):
            self._cancel(action, log)
        elif isinstance(action, CancelAll):
            for order in self.open_orders(action.owner):
                if action.good is None or order.good == action.good:
                    self._remove_resting(order, log)
        else:  # pragma: no cover - guarded by typing
            raise TypeError(f"unknown action {action!r}")

    def _new_order(self, tick: int, a: NewOrder, log: TickLog) -> None:
        reason = self._check(a)
        if reason is not None:
            log.rejects.append(Reject(a.owner, reason, client_id=a.client_id))
            return
        self._new_this_tick[a.owner] += 1
        order = Order(
            id=self._next_id,
            owner=a.owner,
            good=a.good,
            side=a.side,
            price=a.price,
            qty=a.qty,
            tif=a.tif,
            tick=tick,
            expire_tick=tick + a.ttl if a.ttl is not None else None,
            client_id=a.client_id,
        )
        self._next_id += 1
        log.acks.append(Ack(a.owner, order.id, a.client_id))

        book = self.books[a.good]
        fills, self_cancelled = book.match(order, tick)
        for maker in self_cancelled:
            self._forget(maker)
            log.cancelled.append(maker)
        for fill in fills:
            self._settle(fill)
            maker = self._open[self._maker_owner(fill)][fill.maker_order_id]
            self._open_qty[(maker.owner, maker.good, maker.side)] -= fill.qty
            if maker.qty == 0:
                del self._open[maker.owner][maker.id]
        log.fills.extend(fills)

        if order.qty > 0 and order.tif == "GTC":
            book.rest(order)
            self._open[order.owner][order.id] = order
            self._open_qty[(order.owner, order.good, order.side)] += order.qty
            if order.expire_tick is not None:
                self._expiry[order.expire_tick].append(order.id)

    def _check(self, a: NewOrder) -> str | None:
        if a.good not in self.books:
            return "unknown good"
        if a.side not in (BUY, SELL):
            return "side must be +1 (buy) or -1 (sell)"
        if not isinstance(a.qty, int) or isinstance(a.qty, bool) or a.qty <= 0:
            return "quantity must be a positive integer"
        if not isinstance(a.price, int) or isinstance(a.price, bool):
            return "price must be an integer"
        if not 1 <= a.price <= self.rules.max_price:
            return "price out of range"
        if a.tif not in TIFS:
            return "tif must be GTC or IOC"
        if is_bot(a.owner):
            return None
        if self._new_this_tick[a.owner] >= self.rules.max_orders_per_tick:
            return "too many orders this tick"
        if a.tif == "GTC" and len(self._open.get(a.owner, ())) >= self.rules.max_open_orders:
            return "too many open orders"
        limit = self.rules.position_limits[a.good]
        position = self.account(a.owner).position.get(a.good, 0)
        if a.side == BUY:
            worst = position + self._open_qty[(a.owner, a.good, BUY)] + a.qty
            if worst > limit:
                return "position limit"
        else:
            worst = position - self._open_qty[(a.owner, a.good, SELL)] - a.qty
            if worst < -limit:
                return "position limit"
        return None

    def _settle(self, fill: Fill) -> None:
        notional = fill.price * fill.qty
        buyer, seller = self.account(fill.buyer), self.account(fill.seller)
        buyer.cash -= notional
        seller.cash += notional
        buyer.position[fill.good] = buyer.position.get(fill.good, 0) + fill.qty
        seller.position[fill.good] = seller.position.get(fill.good, 0) - fill.qty
        taker, maker = (buyer, seller) if fill.aggressor == BUY else (seller, buyer)
        for acct, fee in ((taker, self.rules.taker_fee), (maker, self.rules.maker_fee)):
            if fee and not is_bot(acct.owner):
                acct.cash -= fee * fill.qty
                acct.fees_paid += fee * fill.qty

    @staticmethod
    def _maker_owner(fill: Fill) -> str:
        return fill.seller if fill.aggressor == BUY else fill.buyer

    def _cancel(self, a: Cancel, log: TickLog) -> None:
        order = self._open.get(a.owner, {}).get(a.order_id)
        if order is None:
            log.rejects.append(Reject(a.owner, "unknown order", order_id=a.order_id))
            return
        self._remove_resting(order, log)

    def _remove_resting(self, order: Order, log: TickLog) -> None:
        self.books[order.good].remove(order.id)
        self._forget(order)
        log.cancelled.append(order)

    def _forget(self, order: Order) -> None:
        self._open[order.owner].pop(order.id, None)
        self._open_qty[(order.owner, order.good, order.side)] -= order.qty
