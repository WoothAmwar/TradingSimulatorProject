"""JSON wire format between the exchange and participant bots (identical in every language).

State sent to a bot each tick::

    {"tick": 10000, "goods": ["STABLE", ...], "limits": {"STABLE": 50},
     "order_depths": {"STABLE": {"bids": [[9998, 12], ...], "asks": [[10002, 9], ...]}},
     "market_trades": {"STABLE": [[10001, 3, 1], ...]},   # [price, qty, aggressor side]
     "position": {"STABLE": 4}, "cash": -40012, "fees_paid": 0,
     "open_orders": [{"id": 7, "good": "STABLE", "price": 9999, "qty": 5, ...}],
     "own_trades": [{"good": "STABLE", "price": 10001, "qty": -3, "maker": true}],
     "history_start": 9990, "history": {"STABLE": [10001, 10000.5, ...]}}

``history`` is the market price at every earlier tick (the middle price as each tick opened, as in
prices.csv). Each state carries only the prices the bot hasn't been sent yet, from index
``history_start`` of the whole list on, so the bot's SDK keeps the list.

Response from a bot (every key optional; quantities are signed, + buys and - sells)::

    {"cancel_all": true | ["STABLE"], "cancel": [7, 8],
     "orders": [{"good": "STABLE", "price": 9999, "qty": 5, "tif": "GTC", "client_id": "a"}]}

Cancels are applied before new orders so a bot can replace its quotes within one tick. After a
``cancel_all``, orders sent again unchanged stay in the book and keep their place in line.
Participants' prices past the tick's price band (``ExchangeRules.price_band``) move to its edge.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .book import OrderBook
from .driver import TickDriver
from .types import BUY, SELL, Action, Cancel, CancelAll, NewOrder, Reject

MAX_CANCELS = 200
HISTORY_PER_STATE = 20_000  # a bot that starts late in a long round gets the rest over a few ticks


def _text(value: Any) -> str:
    """str() without NUL or lone surrogates, which can't be stored as jsonb for replay."""
    return "".join(c for c in str(value) if c != "\x00" and not "\ud800" <= c <= "\udfff")


def bot_state(driver: TickDriver, owner: str) -> dict:
    """What ``owner``'s bot sees. The book leaves out its own orders: its reply replaces them, so
    the rest of the market is what it trades against (its orders are still in ``open_orders``)."""
    state = driver.public_state(exclude=owner)
    state["goods"] = list(driver.rules.goods)
    state["limits"] = dict(driver.rules.position_limits)
    state.update(driver.private_state(owner))
    return state


class PriceHistory:
    """The market price at every tick so far: each good's middle price as the tick opened (the
    one side's best price, or the last price, while the book is one-sided or empty)."""

    def __init__(self, goods: Iterable[str]) -> None:
        self.prices: dict[str, list[float]] = {g: [] for g in goods}

    def record(self, books: Mapping[str, OrderBook]) -> None:
        for good, prices in self.prices.items():
            book = books[good]
            mid = book.mid()
            if mid is None:
                mid = book.best_bid() or book.best_ask() or (prices[-1] if prices else None)
            if mid is not None:
                prices.append(int(mid) if mid == int(mid) else mid)

    def add_to(self, state: dict, sent: int) -> int:
        """Adds the prices from index ``sent`` on to a bot's state; returns how many it has."""
        end = sent + HISTORY_PER_STATE
        state["history_start"] = sent
        state["history"] = {g: p[sent:end] for g, p in self.prices.items()}
        return max((sent + len(p) for p in state["history"].values()), default=sent)


def parse_bot_response(owner: str, payload: Any) -> tuple[list[Action], list[Reject]]:
    """Convert a bot's JSON response into actions, collecting malformed entries as rejects."""
    actions: list[Action] = []
    rejects: list[Reject] = []
    if payload is None:
        return actions, rejects
    if not isinstance(payload, dict):
        return actions, [Reject(owner, "response must be an object")]

    cancel_all = payload.get("cancel_all")
    if cancel_all is True:
        actions.append(CancelAll(owner))
    elif isinstance(cancel_all, list):
        actions.extend(CancelAll(owner, _text(g)) for g in cancel_all)
    elif cancel_all not in (None, False):
        rejects.append(Reject(owner, "cancel_all must be true or a list of goods"))

    cancels = payload.get("cancel") or []
    if not isinstance(cancels, list):
        rejects.append(Reject(owner, "cancel must be a list of order ids"))
        cancels = []
    for order_id in cancels[:MAX_CANCELS]:
        if isinstance(order_id, int) and not isinstance(order_id, bool):
            actions.append(Cancel(owner, order_id))
        else:
            rejects.append(Reject(owner, "order id must be an integer"))

    orders = payload.get("orders") or []
    if not isinstance(orders, list):
        return actions, [*rejects, Reject(owner, "orders must be a list")]
    for raw in orders:
        if not isinstance(raw, dict):
            rejects.append(Reject(owner, "order must be an object"))
            continue
        client_id = raw.get("client_id")
        client_id = None if client_id is None else _text(client_id)[:64]
        qty = raw.get("qty")
        if not isinstance(qty, int) or isinstance(qty, bool) or qty == 0:
            rejects.append(Reject(owner, "qty must be a non-zero integer", client_id=client_id))
            continue
        price = raw.get("price")
        # Checked here too, not only by the exchange: rejected orders are still persisted for
        # replay, and a NaN or float price would fail to serialise or replay differently.
        if not isinstance(price, int) or isinstance(price, bool):
            rejects.append(Reject(owner, "price must be an integer", client_id=client_id))
            continue
        actions.append(
            NewOrder(
                owner=owner,
                good=_text(raw.get("good")),
                side=BUY if qty > 0 else SELL,
                price=price,  # range validated by the exchange
                qty=abs(qty),
                tif=_text(raw.get("tif", "GTC")).upper(),
                client_id=client_id,
            )
        )
    return actions, rejects
