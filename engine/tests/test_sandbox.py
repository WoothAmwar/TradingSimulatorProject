"""The bot sandbox: Python bots in CPython for WASI, C/C++ builds as WASI reactors.

The Python tests need CPython for WASI (`python -m server.wasi_python install`). The C/C++ tests
use a hand-written reactor; web/runtime-tests checks real Clang builds against the browser."""

import asyncio

import pytest
from wasmtime import wat2wasm

from server import sandbox
from server.sandbox import (
    DEFAULT_PYTHON_DIR,
    BotError,
    PythonBot,
    Sandbox,
    WasmBot,
    state_to_text,
    text_to_response,
)

needs_python = pytest.mark.skipif(
    not (DEFAULT_PYTHON_DIR / "python.wasm").exists(),
    reason="CPython for WASI isn't installed (python -m server.wasi_python install)",
)

STATE = {
    "tick": 10_000,
    "goods": ["STABLE"],
    "limits": {"STABLE": 50},
    "order_depths": {"STABLE": {"bids": [[9998, 12], [9997, 5]], "asks": [[10003, 9]]}},
    "market_trades": {"STABLE": [[10001, 3, 1]]},
    "position": {"STABLE": 4},
    "cash": -40012,
    "fees_paid": 0,
    "open_orders": [],
    "own_trades": [{"good": "STABLE", "price": 10001, "qty": -3, "maker": True}],
}

STARTER = """
from trader_sdk import buy, sell

class Trader:
    def __init__(self):
        self.seen = 0
        print("loaded")

    def run(self, state):
        self.seen += 1  # remembered between ticks
        print("tick", state.tick, "seen", self.seen)
        return [buy(state.bids[0][0] + 1, 5), sell(state.asks[0][0] - 1, 5)]
"""

_sandbox: Sandbox | None = None


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 60))


def shared() -> Sandbox:
    global _sandbox
    _sandbox = _sandbox or Sandbox()
    return _sandbox


async def python_bot(source: str) -> PythonBot:
    bot = PythonBot(shared(), source)
    await bot.start()
    return bot


@needs_python
def test_python_bot_trades_and_keeps_its_memory():
    async def scenario():
        bot = PythonBot(shared(), STARTER)
        assert await bot.start() == ["loaded"]
        first = await bot.tick(STATE)
        second = await bot.tick(STATE)
        assert first.error is None and first.logs == ["tick 10000 seen 1"]
        assert second.logs == ["tick 10000 seen 2"]
        assert first.response == {
            "cancel_all": True,
            "orders": [
                {"good": "STABLE", "price": 9999, "qty": 5},
                {"good": "STABLE", "price": 10002, "qty": -5},
            ],
        }
        bot.close()

    run(scenario())


@needs_python
def test_python_errors_are_reported_and_the_bot_keeps_going():
    async def scenario():
        bot = await python_bot(
            "class Trader:\n"
            "    def run(self, s):\n"
            "        if s.tick == 1:\n"
            "            return 1 / 0\n"
            "        return []\n"
        )
        failed = await bot.tick({**STATE, "tick": 1})
        assert failed.response is None
        assert failed.error.startswith("Traceback") and 'File "trader.py"' in failed.error
        assert "ZeroDivisionError" in failed.error and "wasi_main" not in failed.error
        assert (await bot.tick(STATE)).response == {"cancel_all": True, "orders": []}
        bot.close()

    run(scenario())


@needs_python
@pytest.mark.parametrize(
    ("source", "message"),
    [
        ("x = (", "SyntaxError"),
        ("y = 1", "class named Trader"),
        ("import numpy\nclass Trader: pass", "only Python's standard library"),
        ("from . import helper\nclass Trader: pass", "single file"),
    ],
)
def test_python_bot_that_cannot_load(source, message):
    async def scenario():
        with pytest.raises(BotError, match=message):
            await PythonBot(shared(), source).start()

    run(scenario())


@needs_python
def test_python_bot_gets_a_state_bigger_than_a_pipe():
    async def scenario():
        bot = await python_bot(
            "class Trader:\n"
            "    def run(self, s):\n"
            "        print(len(s.history))\n"
            "        return []\n"
        )
        history = {"history_start": 0, "history": {"STABLE": [10_000.5] * 30_000}}
        reply = await bot.tick({**STATE, **history})
        assert reply.error is None and reply.logs == ["30000"]
        bot.close()

    run(scenario())


@needs_python
def test_python_bot_sees_nothing_outside_its_sandbox():
    probe = """
import os

def attempt(fn):
    try:
        fn()
        return "allowed"
    except Exception as exc:
        return type(exc).__name__

class Trader:
    def run(self, s):
        print("env", dict(os.environ))
        print("etc", attempt(lambda: open("/etc/passwd").read()))
        print("engine", attempt(lambda: os.listdir("/app")))
        print("write", attempt(lambda: open("/bot/trader.py", "w").write("x")))
        print("socket", attempt(lambda: __import__("socket").create_connection(("1.1.1.1", 80))))
        print("memory", attempt(lambda: bytearray(200 * 1024 * 1024)))
        return []
"""

    async def scenario():
        bot = await python_bot(probe)
        logs = dict(line.split(" ", 1) for line in (await bot.tick(STATE)).logs)
        assert logs["env"] == "{}"
        assert logs["etc"] in ("FileNotFoundError", "PermissionError", "OSError")
        assert logs["engine"] in ("FileNotFoundError", "PermissionError", "OSError")
        assert logs["write"] != "allowed" and logs["socket"] != "allowed"
        assert logs["memory"] == "MemoryError"  # over the 64 MB limit
        bot.close()

    run(scenario())


@needs_python
def test_watchdog_stops_a_bot_that_never_returns(monkeypatch):
    monkeypatch.setattr(sandbox, "CALL_LIMIT_S", 0.5)

    async def scenario():
        bot = await python_bot(
            "class Trader:\n    def run(self, s):\n        while True:\n            pass\n"
        )
        with pytest.raises(BotError, match="took longer than"):
            await bot.tick(STATE)
        assert bot.dead and not bot.busy
        with pytest.raises(BotError):
            await bot.tick(STATE)

    run(scenario())


@needs_python
def test_closing_an_idle_python_bot_ends_it():
    async def scenario():
        bot = await python_bot(STARTER)
        bot.close()
        for _ in range(100):
            if bot.dead:
                break
            await asyncio.sleep(0.02)
        assert bot.dead == "was stopped"

    run(scenario())


# A stand-in for a Clang build of web/public/runtimes/sdk/harness.c: it prints on bot_init,
# echoes the first line of its input as a log, returns two orders, and loops forever on its
# third tick.
REACTOR = r"""
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (global $ticks (mut i32) (i32.const 0))
  (data (i32.const 2048) "loaded\0a")
  (data (i32.const 8192) "9999 5\0a10002 -5\0a\00")
  (func $print (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func (export "bot_input") (result i32) (i32.const 4096))
  (func (export "bot_input_capacity") (result i32) (i32.const 4000))
  (func (export "bot_init") (call $print (i32.const 2048) (i32.const 7)))
  (func (export "bot_tick") (param $len i32) (result i32)
    (local $end i32)
    (global.set $ticks (i32.add (global.get $ticks) (i32.const 1)))
    (if (i32.eq (global.get $ticks) (i32.const 3)) (then (loop $forever (br $forever))))
    ;; print the input's first line (up to and including its newline)
    (local.set $end (i32.const 4096))
    (block $done
      (loop $scan
        (br_if $done (i32.eq (i32.load8_u (local.get $end)) (i32.const 10)))
        (local.set $end (i32.add (local.get $end) (i32.const 1)))
        (br $scan)))
    (call $print
      (i32.const 4096)
      (i32.sub (i32.add (local.get $end) (i32.const 1)) (i32.const 4096)))
    (i32.const 8192)))
"""


def test_wasm_bot_runs_a_reactor_build(monkeypatch):
    monkeypatch.setattr(sandbox, "CALL_LIMIT_S", 0.5)

    async def scenario():
        bot = WasmBot(shared(), wat2wasm(REACTOR), "cpp")
        assert await bot.start() == ["loaded"]
        reply = await bot.tick(STATE)
        assert reply.logs == ["T 10000 -40012 4 50"]
        assert reply.response == {
            "cancel_all": True,
            "orders": [
                {"good": "STABLE", "price": 9999, "qty": 5},
                {"good": "STABLE", "price": 10002, "qty": -5},
            ],
        }
        await bot.tick(STATE)
        with pytest.raises(BotError, match="took longer than"):
            await bot.tick(STATE)  # the third tick never returns

    run(scenario())


def test_wasm_bot_rejects_a_module_that_is_not_a_bot():
    async def scenario():
        with pytest.raises(BotError, match="lacks"):
            await WasmBot(shared(), wat2wasm('(module (memory (export "memory") 1))'), "c").start()
        with pytest.raises(BotError, match="valid WebAssembly"):
            await WasmBot(shared(), b"not wasm", "c").start()

    run(scenario())


def test_c_text_protocol_matches_the_browser_harness():
    assert state_to_text(STATE) == (
        "T 10000 -40012 4 50\nB 2 9998 12 9997 5\nA 1 10003 9\nX 1 10001 3\n"
    )
    empty = {**STATE, "order_depths": {"STABLE": {"bids": [], "asks": []}}, "market_trades": {}}
    assert state_to_text(empty).splitlines()[1:] == ["B 0 ", "A 0 ", "X 0 "]
    assert state_to_text({**STATE, "prices": {"STABLE": [5, 6]}}).endswith("P 2 5 6\n")
    assert text_to_response("101 5\nnoise\n99 -3\n7 0\n", "STABLE") == {
        "cancel_all": True,
        "orders": [
            {"good": "STABLE", "price": 101, "qty": 5},
            {"good": "STABLE", "price": 99, "qty": -3},
        ],
    }
