"""The `trader_sdk` module that bots import: buy(), sell() and the flat state of the round's good.

The same file runs in the browser (Pyodide) and in the engine's sandbox (CPython for WASI);
`npm run sync:engine` copies it to web/public/py/bot_sdk/.
"""


class Order:
    """One order: qty > 0 buys, qty < 0 sells."""

    __slots__ = ("price", "qty")

    def __init__(self, price, qty):
        self.price = price
        self.qty = qty

    def __eq__(self, other):
        return isinstance(other, Order) and (self.price, self.qty) == (other.price, other.qty)

    def __repr__(self):
        return f"Order(price={self.price!r}, qty={self.qty!r})"


def buy(price, qty=1):
    """An order to buy qty units, paying at most price for each."""
    return Order(price, abs(qty))


def sell(price, qty=1):
    """An order to sell qty units, getting at least price for each."""
    return Order(price, -abs(qty))


class TradingState:
    """What run(state) gets every tick. Every round trades a single good."""

    def __init__(self, d):
        good = d["goods"][0]
        book = d["order_depths"][good]
        self.tick = d["tick"]
        # Other traders' offers (a bot's own resting orders aren't in them): buys highest first,
        # sells lowest first.
        self.bids = [tuple(level) for level in book["bids"]]
        self.asks = [tuple(level) for level in book["asks"]]
        self.price = _middle(self.bids, self.asks)
        self.position = d["position"][good]
        self.limit = d["limits"][good]
        self.cash = d["cash"]
        self.trades = [(price, qty) for price, qty, _ in d["market_trades"][good]]
        self.my_trades = [(t["price"], t["qty"]) for t in d["own_trades"] if t["good"] == good]
        self.prices = d.get("prices", {}).get(good, ())  # "best time" rounds: every tick's price

    def __getattr__(self, name):
        """Only called for names state lacks, such as state.goods in code for the old API."""
        hint = ""
        if name in _OLD_FIELDS:
            hint = " This code was written for the old bot API; start again from the template."
        raise AttributeError(f"state has no {name!r}. It has: {_FIELDS}.{hint}")


_FIELDS = "tick, price, bids, asks, position, limit, cash, trades, my_trades"
_OLD_FIELDS = {
    "goods",
    "order_depths",
    "market_trades",
    "own_trades",
    "limits",
    "open_orders",
    "fees_paid",
}


def _middle(bids, asks):
    """Halfway between the best offer to buy and the best offer to sell (or whichever exists)."""
    if bids and asks:
        middle = (bids[0][0] + asks[0][0]) / 2
        return int(middle) if middle.is_integer() else middle
    if bids or asks:
        return (bids or asks)[0][0]
    return None
