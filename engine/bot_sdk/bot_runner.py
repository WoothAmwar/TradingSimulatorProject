"""Loads a participant's trader.py and turns each run(state) into the engine's wire response.

Shared by the browser and the engine's sandbox, like trader_sdk.py. Bots may import only Python's
standard library: the engine's sandbox has nothing else, so the browser enforces the same rule.
"""

import ast
import json
import operator
import sys
import types

import trader_sdk

_ALLOWED = sys.stdlib_module_names | {"trader_sdk"}


def check_imports(tree):
    """Rejects imports the live sandbox can't satisfy, before any of the code runs."""
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level:
            raise ImportError("trader.py is a single file, so it has nothing to import from '.'")
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module]
        else:
            continue
        for name in names:
            top = name.split(".")[0]
            if top not in _ALLOWED:
                raise ImportError(
                    f"bots can't import {top!r}: only Python's standard library is available"
                )


def _int(x):
    """Prices and quantities are whole numbers, so a price such as 100.5 is rounded."""
    try:
        return operator.index(x)
    except TypeError:
        return round(x) if isinstance(x, float) else x


def _order(o, good):
    if not isinstance(o, trader_sdk.Order):
        raise TypeError(f"not an order: {o!r}; use buy(price, qty) or sell(price, qty)")
    return {"good": good, "price": _int(o.price), "qty": _int(o.qty)}


def to_response(out, good):
    """Whatever run() returns replaces last tick's orders; None or [] means no orders."""
    if out is None:
        out = []
    elif isinstance(out, trader_sdk.Order):
        out = [out]
    if not isinstance(out, (list, tuple)):
        raise TypeError("run() must return a list of orders, e.g. [buy(100, 5)], or []")
    return {"cancel_all": True, "orders": [_order(o, good) for o in out]}


class Bot:
    def __init__(self, source):
        tree = compile(source, "trader.py", "exec", ast.PyCF_ONLY_AST)
        check_imports(tree)
        mod = types.ModuleType("trader")
        mod.__file__ = "trader.py"
        sys.modules["trader"] = mod
        exec(compile(tree, "trader.py", "exec"), mod.__dict__)
        if not hasattr(mod, "Trader"):
            raise RuntimeError("your code must define a class named Trader")
        self.trader = mod.Trader()

    def tick(self, state):
        return to_response(self.trader.run(trader_sdk.TradingState(state)), state["goods"][0])

    def tick_json(self, state_json):
        return json.dumps(self.tick(json.loads(state_json)))
