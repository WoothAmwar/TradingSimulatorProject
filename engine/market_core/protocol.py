"""JSON wire format between the exchange and participant bots (identical in every language).

State sent to a bot each tick::

    {"tick": 10000, "goods": ["STABLE", ...], "limits": {"STABLE": 50},
     "order_depths": {"STABLE": {"bids": [[9998, 12], ...], "asks": [[10002, 9], ...]}},
     "market_trades": {"STABLE": [[10001, 3, 1], ...]},   # [price, qty, aggressor side]
     "position": {"STABLE": 4}, "cash": -40012, "fees_paid": 0,
     "open_orders": [{"id": 7, "good": "STABLE", "price": 9999, "qty": 5, ...}],
     "own_trades": [{"good": "STABLE", "price": 10001, "qty": -3, "maker": true}]}

Response from a bot (every key optional; quantities are signed, + buys and - sells)::

    {"cancel_all": true | ["STABLE"], "cancel": [7, 8],
     "orders": [{"good": "STABLE", "price": 9999, "qty": 5, "tif": "GTC", "client_id": "a"}]}

Cancels are applied before new orders so a bot can replace its quotes within one tick.
"""

from __future__ import annotations

from typing import Any

from .driver import TickDriver
from .types import BUY, SELL, Action, Cancel, CancelAll, NewOrder, Reject

MAX_CANCELS = 200


def bot_state(driver: TickDriver, owner: str) -> dict:
    state = driver.public_state()
    state["goods"] = list(driver.rules.goods)
    state["limits"] = dict(driver.rules.position_limits)
    state.update(driver.private_state(owner))
    return state


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
        actions.extend(CancelAll(owner, str(g)) for g in cancel_all)
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
        client_id = None if client_id is None else str(client_id)[:64]
        qty = raw.get("qty")
        if not isinstance(qty, int) or isinstance(qty, bool) or qty == 0:
            rejects.append(Reject(owner, "qty must be a non-zero integer", client_id=client_id))
            continue
        actions.append(
            NewOrder(
                owner=owner,
                good=str(raw.get("good")),
                side=BUY if qty > 0 else SELL,
                price=raw.get("price"),  # validated by the exchange
                qty=abs(qty),
                tif=str(raw.get("tif", "GTC")).upper(),
                client_id=client_id,
            )
        )
    return actions, rejects
