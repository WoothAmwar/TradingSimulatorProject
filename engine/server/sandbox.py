"""Runs participant bots on the engine, each inside its own WebAssembly sandbox (wasmtime).

Python bots each get a CPython-for-WASI interpreter running bot_sdk/wasi_main.py. C and C++ bots
run the WASI reactor the browser compiles from web/public/runtimes/sdk/harness.*. A bot can read
only the read-only files it needs: no network, no environment, no other bot, no engine secrets.
Each bot has its own thread at the lowest CPU priority, so the tick loop always runs first, and a
watchdog stops any call that runs too long.

    python -m server.sandbox run python trader.py < states.jsonl   # one JSON reply per line
    python -m server.sandbox run cpp bot.wasm < states.jsonl
"""

from __future__ import annotations

import asyncio
import ctypes
import errno
import hashlib
import json
import logging
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import wasmtime._bindings as ffi  # the epoch deadline callback isn't wrapped by wasmtime-py
from wasmtime import (
    Config,
    Engine,
    ExitTrap,
    Linker,
    Module,
    Store,
    Trap,
    TrapCode,
    WasiConfig,
    WasmtimeError,
)

log = logging.getLogger("engine.sandbox")

ENGINE_ROOT = Path(__file__).resolve().parents[1]
SDK_DIR = ENGINE_ROOT / "bot_sdk"
DEFAULT_PYTHON_DIR = ENGINE_ROOT / "wasi-python"  # installed by server/wasi_python.py

MEMORY_LIMIT = 64 << 20  # bytes of linear memory per bot
START_LIMIT_S = 60.0  # loading the code and building Trader(); slow on 0.1 CPU
CALL_LIMIT_S = 10.0  # one run(state)
EPOCH_S = 0.1  # watchdog resolution
PIPE_WAIT_S = 0.005  # retry interval while a Python bot's stdin pipe is full
MAX_REPLY_BYTES = 1 << 20  # one reply from a bot
MAX_LOG_LINES = 200  # console lines kept from one call
NATIVE_MODULE_CACHE = 32  # compiled C/C++ builds kept in memory


class BotError(Exception):
    """The bot couldn't start, or it stopped and has to be restarted. ``logs``: its output."""

    def __init__(self, message: str, logs: list[str] | None = None) -> None:
        super().__init__(message)
        self.logs = logs or []


@dataclass
class Reply:
    response: dict | None  # the engine's wire response; None when run() raised
    logs: list[str] = field(default_factory=list)
    error: str | None = None


def make_engine() -> Engine:
    """Precompiled modules only load into an engine with this exact configuration."""
    config = Config()
    config.epoch_interruption = True
    return Engine(config)


def load_python_module(engine: Engine, python_dir: Path) -> Module:
    wasm, cwasm = python_dir / "python.wasm", python_dir / "python.cwasm"
    if not wasm.exists():
        raise BotError(
            "Python bots can't run on this server: CPython for WASI isn't installed "
            "(python -m server.wasi_python install)"
        )
    if cwasm.exists():
        try:
            return Module.deserialize_file(engine, str(cwasm))
        except WasmtimeError:
            log.warning("python.cwasm doesn't fit this machine; compiling python.wasm instead")
    return Module.from_file(engine, str(wasm))


class Sandbox:
    """The wasmtime engine every bot on this instance shares, with its compiled modules."""

    def __init__(self, python_dir: Path = DEFAULT_PYTHON_DIR) -> None:
        self.engine = make_engine()
        self.linker = Linker(self.engine)
        self.linker.define_wasi()
        self.python_dir = Path(python_dir)
        self.python_lib = self.python_dir / "lib"
        self._python: Module | None = None
        self._native: OrderedDict[str, Module] = OrderedDict()
        self._lock = threading.Lock()
        threading.Thread(target=self._tick_epochs, name="wasm-epochs", daemon=True).start()

    def _tick_epochs(self) -> None:
        while True:
            time.sleep(EPOCH_S)
            self.engine.increment_epoch()

    def python_module(self) -> Module:
        """Blocking (the first call loads the interpreter): call it from a worker thread."""
        with self._lock:
            if self._python is None:
                self._python = load_python_module(self.engine, self.python_dir)
            return self._python

    def native_module(self, wasm: bytes) -> Module:
        """Blocking: compiles a C/C++ build once and keeps it for restarts."""
        key = hashlib.sha256(wasm).hexdigest()
        with self._lock:
            module = self._native.get(key)
            if module is not None:
                self._native.move_to_end(key)
                return module
        try:
            module = Module(self.engine, wasm)
        except WasmtimeError as exc:
            raise BotError(f"the build isn't valid WebAssembly: {_first_line(exc)}") from exc
        with self._lock:
            self._native[key] = module
            while len(self._native) > NATIVE_MODULE_CACHE:
                self._native.popitem(last=False)
        return module


# Bots ---------------------------------------------------------------------------------------

_DEADLINE_CALLBACK = ffi._wasmtime_store_epoch_deadline_callback.argtypes[1]
_DEADLINE_FINALIZER = ffi._wasmtime_store_epoch_deadline_callback.argtypes[3]
_CONTINUE = 0  # WASMTIME_UPDATE_DEADLINE_CONTINUE


def _watch(store: Store, should_stop: Callable[[], bool]) -> tuple:
    """Calls should_stop() every epoch while the store runs wasm and traps it once that says so.
    Runs on the bot's own thread. Returns the callbacks, which must outlive the store."""

    def check(_context, _data, delta, kind):
        if should_stop():
            err = ffi.wasmtime_error_new(ctypes.create_string_buffer(b"stopped by the engine"))
            return ctypes.cast(err, ctypes.c_void_p).value
        delta[0] = 1
        kind[0] = _CONTINUE
        return 0

    callbacks = (_DEADLINE_CALLBACK(check), _DEADLINE_FINALIZER(lambda _data: None))
    ffi.wasmtime_store_epoch_deadline_callback(store.ptr(), callbacks[0], None, callbacks[1])
    store.set_epoch_deadline(1)
    return callbacks


def _lowest_priority() -> None:
    """Linux renices single threads, so bots only get the CPU the tick loop leaves over."""
    if sys.platform == "linux":
        try:
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)
        except OSError:
            pass


def _first_line(exc: BaseException) -> str:
    return (str(exc).strip().splitlines() or [type(exc).__name__])[0]


class _Lines:
    """Splits a bot's output stream into lines, keeping a bounded tail."""

    def __init__(self) -> None:
        self._partial = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        self._partial += data
        if len(self._partial) > MAX_REPLY_BYTES:
            self._partial.clear()
            raise OverflowError
        lines = []
        while (end := self._partial.find(b"\n")) >= 0:
            lines.append(bytes(self._partial[:end]))
            del self._partial[: end + 1]
        return lines


class SandboxedBot:
    """One bot in its own store and thread. Construct it and await its coroutines on the event
    loop; at most one call is in flight (check ``busy`` before ``tick``)."""

    language = ""

    def __init__(self, sandbox: Sandbox, label: str) -> None:
        self.sandbox = sandbox
        self.label = label
        self.dead: str | None = None  # why the bot stopped, once it has
        self._loop = asyncio.get_running_loop()
        self._pending: asyncio.Future | None = None
        self._since: float | None = None  # when the current call started, for the watchdog
        self._limit = START_LIMIT_S
        self._closing = False
        self._timed_out = False
        self._callbacks: tuple = ()

    @property
    def busy(self) -> bool:
        return self._pending is not None

    async def start(self) -> list[str]:
        raise NotImplementedError

    async def tick(self, state: dict) -> Reply:
        raise NotImplementedError

    def close(self) -> None:
        self._closing = True  # the watchdog stops a call that is still running

    def _store(self) -> Store:
        store = Store(self.sandbox.engine)
        store.set_limits(memory_size=MEMORY_LIMIT)
        self._callbacks = _watch(store, self._should_stop)
        return store

    def _should_stop(self) -> bool:
        if self._closing:
            return True
        since = self._since
        if since is not None and time.monotonic() - since > self._limit:
            self._timed_out = True
            return True
        return False

    def _expect(self, limit: float) -> asyncio.Future:
        if self.dead:
            raise BotError(self.dead)
        if self._pending is not None:
            raise BotError("the bot is still busy")
        self._pending = self._loop.create_future()
        self._limit = limit
        self._since = time.monotonic()
        return self._pending

    def _resolve(self, msg: dict) -> None:
        """On the loop: a reply to the call in flight (anything else is ignored)."""
        fut, self._pending = self._pending, None
        if fut is not None and not fut.done():
            fut.set_result(msg)

    def _died(self, reason: str) -> None:
        """On the loop: the bot's thread has ended."""
        self.dead = self.dead or reason
        fut, self._pending = self._pending, None
        if fut is not None and not fut.done():
            fut.set_exception(BotError(self.dead))

    def _crash_reason(self, exc: BaseException) -> str:
        if self._closing:
            return "was stopped"
        if self._timed_out:
            return f"took longer than {self._limit:.0f} s and was stopped"
        if isinstance(exc, ExitTrap):
            return f"exited with code {exc.code}"
        if isinstance(exc, Trap) and exc.trap_code == TrapCode.STACK_OVERFLOW:
            return "ran out of stack space (too much recursion?)"
        return f"crashed: {_first_line(exc)}"

    def _post(self, fn: Callable, *args) -> None:
        """From the bot's thread to the event loop (which may already be closed at shutdown)."""
        try:
            self._loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:
            pass

    def _spawn(self, target: Callable[[], None]) -> None:
        def run() -> None:
            _lowest_priority()
            target()

        threading.Thread(target=run, name=f"bot-{self.label}", daemon=True).start()


class PythonBot(SandboxedBot):
    """A CPython-for-WASI interpreter fed one state per line through a FIFO."""

    language = "python"

    def __init__(self, sandbox: Sandbox, source: str, label: str = "bot") -> None:
        super().__init__(sandbox, label)
        self._source = source
        self._dir: str | None = None
        self._stdin: int | None = None
        self._stdout = _Lines()
        self._stderr: list[str] = []

    async def start(self) -> list[str]:
        module = await asyncio.to_thread(self.sandbox.python_module)
        self._dir = tempfile.mkdtemp(prefix="bot-")
        Path(self._dir, "trader.py").write_text(self._source, encoding="utf-8")
        fifo = os.path.join(self._dir, "stdin")
        os.mkfifo(fifo, 0o600)
        # Read-write, so opening never waits for the other end; unlinked once both ends are open.
        self._stdin = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        wasi = WasiConfig()
        wasi.argv = ["python", "-I", "-S", "-B", "/sdk/wasi_main.py"]
        wasi.preopen_dir(str(self.sandbox.python_lib), "/lib", False)
        wasi.preopen_dir(str(SDK_DIR), "/sdk", False)
        wasi.preopen_dir(self._dir, "/bot", False)
        wasi.stdin_file = fifo
        wasi.stdout_custom = self._on_stdout
        wasi.stderr_custom = self._on_stderr
        store = self._store()
        store.set_wasi(wasi)
        os.unlink(fifo)

        reply = self._expect(START_LIMIT_S)
        self._spawn(lambda: self._run(module, store))
        msg = await reply
        if "error" in msg:
            self.close()
            raise BotError(msg["error"].rstrip(), msg.get("logs", []))
        return msg.get("logs", [])

    async def tick(self, state: dict) -> Reply:
        data = json.dumps(state, separators=(",", ":")).encode() + b"\n"
        reply = self._expect(CALL_LIMIT_S)
        try:
            view = memoryview(data)
<<<<<<< Updated upstream
            while view:  # a pipe holds only 64 KB, so a long history goes in as the bot reads it
                try:
                    view = view[os.write(self._stdin, view) :]
                except BlockingIOError:
                    if reply.done():  # the bot died or was stopped
                        break
                    await asyncio.sleep(0.005)
=======
            while view and not reply.done():
                try:
                    view = view[os.write(self._stdin, view) :]
                except BlockingIOError:  # a big state (the first has all of prices.csv) fills the
                    await asyncio.sleep(PIPE_WAIT_S)  # pipe; wait for the bot to read some
>>>>>>> Stashed changes
        except (OSError, TypeError) as exc:
            self._pending = None
            raise BotError("couldn't send the bot its state") from exc
        msg = await reply
        return Reply(msg.get("response"), msg.get("logs", []), msg.get("error"))

    def close(self) -> None:
        super().close()
        if self._stdin is not None:
            os.close(self._stdin)  # an idle bot reads end-of-file and exits
            self._stdin = None

    def _run(self, module: Module, store: Store) -> None:
        try:
            instance = self.sandbox.linker.instantiate(store, module)
            instance.exports(store)["_start"](store)
            reason = "was stopped" if self._closing else "exited"
        except Exception as exc:
            reason = self._crash_reason(exc)
            if self._stderr and not (self._closing or self._timed_out):
                reason += "\n" + "".join(self._stderr)[-2000:]
        finally:
            if self._dir:
                shutil.rmtree(self._dir, ignore_errors=True)
        self._post(self._died, reason)

    def _on_stdout(self, data: bytes) -> int | None:
        """On the bot's thread: each complete line is a reply."""
        try:
            lines = self._stdout.feed(data)
        except OverflowError:
            return -errno.EIO  # the bot's write fails, so a runaway reply ends it
        for line in lines:
            self._since = None  # the watchdog only times calls
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict):
                self._post(self._resolve, msg)
        return None

    def _on_stderr(self, data: bytes) -> None:
        """The interpreter's own errors (bot output is captured inside the sandbox)."""
        if sum(map(len, self._stderr)) < 8000:
            self._stderr.append(data.decode("utf-8", "replace"))


class WasmBot(SandboxedBot):
    """A C or C++ build: a WASI reactor exporting bot_init, bot_input and bot_tick."""

    EXPORTS = ("memory", "bot_input", "bot_input_capacity", "bot_init", "bot_tick")

    def __init__(self, sandbox: Sandbox, wasm: bytes, language: str, label: str = "bot") -> None:
        super().__init__(sandbox, label)
        self.language = language
        self._wasm = wasm
        self._jobs: queue.SimpleQueue = queue.SimpleQueue()
        self._output = _Lines()
        self._logs: list[str] = []
        self._store_ref: Store | None = None
        self._exports = None

    async def start(self) -> list[str]:
        reply = self._expect(START_LIMIT_S)
        self._spawn(self._serve)
        self._jobs.put(None)
        msg = await reply
        if "error" in msg:
            self.close()
            raise BotError(msg["error"], msg.get("logs", []))
        return msg.get("logs", [])

    async def tick(self, state: dict) -> Reply:
        reply = self._expect(CALL_LIMIT_S)
        self._jobs.put(state)
        msg = await reply
        return Reply(msg.get("response"), msg.get("logs", []), msg.get("error"))

    def close(self) -> None:
        super().close()
        self._jobs.put(False)

    def _serve(self) -> None:
        """The bot's thread: the start-up job (None), then one state per tick; False ends it."""
        reason = "was stopped"
        while (job := self._jobs.get()) is not False:
            try:
                msg = self._start_sync() if job is None else self._tick_sync(job)
            except BotError as exc:
                msg = {"error": str(exc)}
            except Exception as exc:
                if self._closing or self._timed_out or job is None:
                    reason = self._crash_reason(exc)
                    break
                msg = {"error": f"run() {self._crash_reason(exc)}"}  # like an exception in Python
            msg["logs"], self._logs = self._logs, []
            self._since = None
            self._post(self._resolve, msg)
            if job is None and "error" in msg:
                break
        self._post(self._died, reason)

    def _start_sync(self) -> dict:
        module = self.sandbox.native_module(self._wasm)
        store = self._store()
        wasi = WasiConfig()
        wasi.stdout_custom = self._on_output
        wasi.stderr_custom = self._on_output
        store.set_wasi(wasi)
        instance = self.sandbox.linker.instantiate(store, module)
        exports = instance.exports(store)
        missing = [name for name in self.EXPORTS if name not in exports]
        if missing:
            raise BotError(f"this isn't a bot build (it lacks {', '.join(missing)})")
        if "_initialize" in exports:
            exports["_initialize"](store)
        exports["bot_init"](store)
        self._store_ref, self._exports = store, exports
        return {"ready": True}

    def _tick_sync(self, state: dict) -> dict:
        store, ex = self._store_ref, self._exports
        text = state_to_text(state).encode()
        if len(text) > ex["bot_input_capacity"](store):
            raise BotError("the state is too large for the C/C++ harness")
        memory = ex["memory"]
        memory.write(store, text, ex["bot_input"](store))
        out = ex["bot_tick"](store, len(text))
        size = memory.data_len(store)
        if not isinstance(out, int) or not 0 <= out < size:
            raise BotError("bot_tick returned an invalid pointer")
        data = memory.read(store, out, min(out + MAX_REPLY_BYTES, size))
        end = data.find(b"\0")
        if end < 0:
            raise BotError("bot_tick's reply has no end")
        text = data[:end].decode("utf-8", "replace")
        return {"response": text_to_response(text, state["goods"][0])}

    def _on_output(self, data: bytes) -> None:
        try:
            lines = self._output.feed(data)
        except OverflowError:
            lines = [b"... output cut short"]
        room = MAX_LOG_LINES - len(self._logs)
        self._logs.extend(line.decode("utf-8", "replace") for line in lines[: max(room, 0)])


def make_bot(
    sandbox: Sandbox, language: str, source: str, wasm: bytes | None, label: str
) -> SandboxedBot:
    if language == "python":
        return PythonBot(sandbox, source, label)
    if language in ("c", "cpp") and wasm is not None:
        return WasmBot(sandbox, wasm, language, label)
    raise BotError(f"{language} bots can't run on the server")


# The C/C++ harness's flat text protocol (stateToText / textToResponse in bot-host.js) ----------


def state_to_text(s: dict) -> str:
    good = s["goods"][0]
    book = s["order_depths"].get(good) or {"bids": [], "asks": []}
    trades = [(t[0], t[1]) for t in s["market_trades"].get(good, [])]

    def pairs(levels) -> str:
        return " ".join(f"{price} {qty}" for price, qty, *_ in levels)

    lines = [
        f"T {s['tick']} {s['cash']} {s['position'].get(good, 0)} {s['limits'].get(good, 0)}",
        f"B {len(book['bids'])} {pairs(book['bids'])}",
        f"A {len(book['asks'])} {pairs(book['asks'])}",
        f"X {len(trades)} {pairs(trades)}",
    ]
    prices = (s.get("prices") or {}).get(good)
    if prices is not None:
        lines.append(f"P {len(prices)} {' '.join(map(str, prices))}")
    if "history" in s:  # the prices the bot hasn't been sent yet, from index history_start on
        new = s["history"].get(good, [])
        lines.append(f"H {s.get('history_start', 0)} {len(new)} {' '.join(map(str, new))}")
    lowest = (s.get("min_positions") or {}).get(good)
    if lowest is not None:
        lines.append(f"M {lowest}")
    return "\n".join(lines) + "\n"


def text_to_response(text: str, good: str) -> dict:
    """The harness writes one "price qty" line per order; they replace last tick's orders."""
    orders = []
    for line in text.split("\n"):
        parts = line.split()
        try:
            price, qty = int(parts[0]), int(parts[1])
        except (IndexError, ValueError):
            continue
        if qty:
            orders.append({"good": good, "price": price, "qty": qty})
    return {"cancel_all": True, "orders": orders}


# Command line -------------------------------------------------------------------------------


async def _run_cli(language: str, path: str) -> None:
    sandbox = Sandbox(Path(os.environ.get("WASI_PYTHON_DIR", DEFAULT_PYTHON_DIR)))
    data = Path(path).read_bytes()
    if language in ("c", "cpp"):
        bot = make_bot(sandbox, language, "", data, "cli")
    else:
        bot = make_bot(sandbox, language, data.decode(), None, "cli")
    try:
        logs = await bot.start()
        print(json.dumps({"ready": True, "logs": logs}), flush=True)
    except BotError as exc:
        print(json.dumps({"error": str(exc), "logs": exc.logs}), flush=True)
        return
    for line in sys.stdin:
        if line.strip():
            reply = await bot.tick(json.loads(line))
            print(json.dumps(reply.__dict__), flush=True)
    bot.close()


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "run":
        sys.exit(__doc__)
    asyncio.run(_run_cli(sys.argv[2], sys.argv[3]))
