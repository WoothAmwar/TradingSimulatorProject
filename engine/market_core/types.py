"""Value types for orders, fills and the actions that drive a tick."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

BUY = 1
SELL = -1
TIFS = ("GTC", "IOC")
BOT_PREFIX = "bot:"


def is_bot(owner: str) -> bool:
    return owner.startswith(BOT_PREFIX)


@dataclass(slots=True)
class Order:
    id: int
    owner: str
    good: str
    side: int
    price: int
    qty: int  # remaining quantity
    tif: str
    tick: int
    expire_tick: int | None = None  # removed at the start of this tick
    client_id: str | None = None


@dataclass(frozen=True, slots=True)
class Fill:
    tick: int
    good: str
    price: int
    qty: int
    buyer: str
    seller: str
    aggressor: int  # side of the taker
    maker_order_id: int
    taker_order_id: int


@dataclass(frozen=True, slots=True)
class NewOrder:
    owner: str
    good: str
    side: int
    price: int
    qty: int
    tif: str = "GTC"
    ttl: int | None = None  # ticks the order may rest before it expires
    client_id: str | None = None


@dataclass(frozen=True, slots=True)
class Cancel:
    owner: str
    order_id: int


@dataclass(frozen=True, slots=True)
class CancelAll:
    owner: str
    good: str | None = None  # None cancels across every good


Action = NewOrder | Cancel | CancelAll


@dataclass(frozen=True, slots=True)
class Reject:
    owner: str
    reason: str
    client_id: str | None = None
    order_id: int | None = None


@dataclass(frozen=True, slots=True)
class Ack:
    owner: str
    order_id: int
    client_id: str | None = None


def action_to_dict(action: Action) -> dict[str, Any]:
    if isinstance(action, NewOrder):
        d: dict[str, Any] = {
            "type": "new",
            "owner": action.owner,
            "good": action.good,
            "side": action.side,
            "price": action.price,
            "qty": action.qty,
            "tif": action.tif,
        }
        if action.ttl is not None:
            d["ttl"] = action.ttl
        if action.client_id is not None:
            d["client_id"] = action.client_id
        return d
    if isinstance(action, Cancel):
        return {"type": "cancel", "owner": action.owner, "order_id": action.order_id}
    return {"type": "cancel_all", "owner": action.owner, "good": action.good}


def action_from_dict(d: dict[str, Any]) -> Action:
    kind = d["type"]
    if kind == "new":
        return NewOrder(
            owner=d["owner"],
            good=d["good"],
            side=d["side"],
            price=d["price"],
            qty=d["qty"],
            tif=d.get("tif", "GTC"),
            ttl=d.get("ttl"),
            client_id=d.get("client_id"),
        )
    if kind == "cancel":
        return Cancel(owner=d["owner"], order_id=d["order_id"])
    if kind == "cancel_all":
        return CancelAll(owner=d["owner"], good=d.get("good"))
    raise ValueError(f"unknown action type {kind!r}")
