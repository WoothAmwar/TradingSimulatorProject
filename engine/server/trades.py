"""Group trades for the public market feed: every fill a group took part in, and per-group totals.

Viewers see who traded with whom (another group, or the computer traders), at what price, and how
that price compared with the market price when the tick opened. Bots can't read the feed.
web/components/market/group-trades.tsx adds later trades to the totals the same way.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping

from market_core.types import BUY, SELL, Fill, is_bot

TRADE_HISTORY = 300  # recent trades kept for viewers that connect later


class TradeLog:
    def __init__(self) -> None:
        self.recent: deque[dict] = deque(maxlen=TRADE_HISTORY)
        self.stats: dict[str, dict] = {}  # group id -> totals for the whole round

    def add_fills(
        self,
        tick: int,
        fills: Iterable[Fill],
        mids: Mapping[str, float | None],
        names: Mapping[str, str],
    ) -> list[dict]:
        """Records the tick's fills that involve a group; ``mids``: each good's middle price when
        the tick opened. Returns the new rows as viewers see them."""
        rows = []
        for f in fills:
            buyer = None if is_bot(f.buyer) else f.buyer
            seller = None if is_bot(f.seller) else f.seller
            if buyer or seller:
                mid = mids.get(f.good)
                rows.append(
                    self.add(tick, f.good, f.price, f.qty, f.aggressor, buyer, seller, mid, names)
                )
        return rows

    def add(
        self,
        tick: int,
        good: str,
        price: int,
        qty: int,
        aggressor: int,
        buyer: str | None,
        seller: str | None,
        mid: float | None,
        names: Mapping[str, str],
    ) -> dict:
        """One fill; ``buyer`` or ``seller`` is None when it was a computer trader."""

        def party(group_id: str | None) -> dict | None:
            return None if group_id is None else {"id": group_id, "name": names.get(group_id, "?")}

        row = {
            "tick": tick,
            "good": good,
            "price": price,
            "qty": qty,
            "aggressor": aggressor,  # the side that took the price
            "mid": mid,  # the market price when the tick opened
            "buyer": party(buyer),
            "seller": party(seller),
        }
        self.recent.append(row)
        for side, me, other in (
            (BUY, row["buyer"], row["seller"]),
            (SELL, row["seller"], row["buyer"]),
        ):
            if me is not None:
                self._count(me, side, row, other is not None)
        return row

    def _count(self, me: dict, side: int, row: dict, with_group: bool) -> None:
        s = self.stats.setdefault(
            me["id"],
            {
                "name": me["name"],
                "trades": 0,
                "bought": 0,
                "sold": 0,
                "spent": 0,
                "received": 0,
                "edge": 0.0,  # how much better than the market price, times units
                "with_groups": 0,
                "took": 0,
            },
        )
        s["name"] = me["name"]
        s["trades"] += 1
        if side == BUY:
            s["bought"] += row["qty"]
            s["spent"] += row["price"] * row["qty"]
        else:
            s["sold"] += row["qty"]
            s["received"] += row["price"] * row["qty"]
        if row["mid"] is not None:
            s["edge"] += (row["mid"] - row["price"]) * row["qty"] * side
        s["with_groups"] += with_group
        s["took"] += row["aggressor"] == side

    def snapshot(self) -> dict:
        return {
            "group_trades": list(self.recent),
            "group_stats": {g: {**s, "edge": round(s["edge"], 2)} for g, s in self.stats.items()},
        }

    @classmethod
    def from_rows(
        cls,
        rows: Iterable[dict],
        mids: Mapping[tuple[int, str], float],
        names: Mapping[str, str],
    ) -> TradeLog:
        """Rebuilds a finished lobby's log from its ``participant_fills`` rows (oldest first) and
        each (tick, good)'s opening middle price (``market_snapshots.mid``)."""
        log = cls()
        for r in rows:
            log.add(
                r["tick"],
                r["good"],
                r["price"],
                r["qty"],
                r["aggressor"],
                r["buyer_group"],
                r["seller_group"],
                mids.get((r["tick"], r["good"])),
                names,
            )
        return log
