// Module worker that runs one participant bot, and for backtests also the matching engine. It is
// created from a data: URL inside a sandboxed (opaque-origin) iframe, so user code cannot reach the
// page, its cookies or its storage. Requests: {id, cmd, args} -> {id, ok, result|error, logs}.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const WASI_SHIM_URL = "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js";

const SDK_SOURCE = `
from dataclasses import dataclass, field


@dataclass
class Order:
    good: str
    price: int
    qty: int            # > 0 buys, < 0 sells
    tif: str = "GTC"    # "GTC" rests on the book, "IOC" cancels any unfilled part
    client_id: str | None = None


@dataclass
class Book:
    bids: list          # [(price, qty)], best (highest) first
    asks: list          # [(price, qty)], best (lowest) first


@dataclass
class Response:
    """Return this instead of a list to keep resting orders: nothing is cancelled unless asked."""
    orders: list = field(default_factory=list)
    cancel: list = field(default_factory=list)   # order ids from state.open_orders
    cancel_all: bool = False


class TradingState:
    def __init__(self, d):
        self.raw = d
        self.tick = d["tick"]
        self.goods = d["goods"]
        self.limits = d["limits"]
        self.order_depths = {
            g: Book([tuple(l) for l in b["bids"]], [tuple(l) for l in b["asks"]])
            for g, b in d["order_depths"].items()
        }
        self.market_trades = {g: [tuple(t) for t in ts] for g, ts in d["market_trades"].items()}
        self.position = d["position"]
        self.cash = d["cash"]
        self.open_orders = d["open_orders"]
        self.own_trades = d["own_trades"]
`;

const HARNESS = `
import json, sys, types, traceback, operator

_sdk = types.ModuleType("trader_sdk")
exec(${JSON.stringify(SDK_SOURCE)}, _sdk.__dict__)
sys.modules["trader_sdk"] = _sdk


def _int(x):
    try:
        return operator.index(x)
    except TypeError:
        return int(x) if isinstance(x, float) and x.is_integer() else x


def _order(o):
    if isinstance(o, _sdk.Order):
        d = {"good": o.good, "price": _int(o.price), "qty": _int(o.qty), "tif": o.tif}
        if o.client_id is not None:
            d["client_id"] = o.client_id
        return d
    if isinstance(o, dict):
        return {**o, "price": _int(o.get("price")), "qty": _int(o.get("qty"))}
    if isinstance(o, (tuple, list)) and len(o) == 3:
        return {"good": o[0], "price": _int(o[1]), "qty": _int(o[2])}
    raise TypeError(f"not an order: {o!r}")


def _to_response(out):
    if out is None:
        return None
    if isinstance(out, _sdk.Response):
        return {"orders": [_order(o) for o in out.orders], "cancel": list(out.cancel),
                "cancel_all": bool(out.cancel_all)}
    if isinstance(out, (list, tuple)):
        return {"cancel_all": True, "orders": [_order(o) for o in out]}
    raise TypeError("run() must return a list of Order objects or a Response")


class _PyBot:
    def __init__(self, source):
        mod = types.ModuleType("trader")
        mod.__file__ = "trader.py"
        sys.modules["trader"] = mod
        exec(compile(source, "trader.py", "exec"), mod.__dict__)
        if not hasattr(mod, "Trader"):
            raise RuntimeError("your code must define a class named Trader")
        self.trader = mod.Trader()

    def tick(self, state):
        return _to_response(self.trader.run(_sdk.TradingState(state)))

    def tick_json(self, state_json):
        return json.dumps(self.tick(json.loads(state_json)))


def _start_backtest(manifest_json, events_gz):
    import gzip
    from market_core.backtest import Backtest
    text = gzip.decompress(events_gz.to_bytes()).decode()
    events = [json.loads(line) for line in text.splitlines() if line]
    return Backtest(json.loads(manifest_json), events, owner="you")


def _run_backtest(bt, py_bot, js_tick, max_ticks, every, progress):
    goods = list(bt.rules.goods)
    series, fills, errors = [], [], []
    rejects = 0
    n = 0
    while n < max_ticks:
        state = bt.open_next()
        if state is None:
            break
        try:
            if py_bot is not None:
                response = py_bot.tick(state)
            else:
                response = json.loads(js_tick(json.dumps(state)) or "null")
        except Exception as exc:
            response = None
            if len(errors) < 20:
                errors.append({"tick": state["tick"], "error": traceback.format_exc()[-3000:]})
        summary = bt.close(response)
        series.append([summary["tick"], round(summary["pnl"], 2)] + [summary["position"][g] for g in goods])
        if len(fills) < 5000:
            fills.extend({**f, "tick": summary["tick"]} for f in summary["fills"])
        rejects += len(summary["rejects"])
        n += 1
        if n % every == 0:
            progress(n)
    return json.dumps({"goods": goods, "series": series, "fills": fills, "rejects": rejects,
                       "errors": errors, "ticks": n})
`;

let logs = [];
let pyodidePromise = null;
let bot = null; // { kind: "python", py } | { kind: "wasm", tick(state) }
let engine = null;

function log(line) {
  logs.push(String(line));
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
}

function takeLogs() {
  const out = logs;
  logs = [];
  return out;
}

async function importPyodide() {
  return (await import(PYODIDE_URL + "pyodide.mjs")).loadPyodide;
}

function getPyodide() {
  pyodidePromise ??= (async () => {
    const loadPyodide = await importPyodide();
    const py = await loadPyodide({ indexURL: PYODIDE_URL, stdout: log, stderr: log });
    py.runPython(HARNESS);
    return py;
  })();
  return pyodidePromise;
}

// Flat text state for compiled languages (see public/runtimes/sdk/harness.c).
function stateToText(s) {
  const lines = [`T ${s.tick} ${s.cash} ${s.goods.length}`];
  for (const g of s.goods) {
    const d = s.order_depths[g] ?? { bids: [], asks: [] };
    const t = s.market_trades[g] ?? [];
    lines.push(`G ${g} ${s.position[g] ?? 0} ${s.limits[g] ?? 0}`);
    lines.push(`B ${d.bids.length} ${d.bids.flat().join(" ")}`);
    lines.push(`A ${d.asks.length} ${d.asks.flat().join(" ")}`);
    lines.push(`X ${t.length} ${t.flat().join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

function textToResponse(text, goods) {
  const orders = [];
  for (const line of text.split("\n")) {
    const [good, price, qty, ioc] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(good) || goods[good] === undefined || !qty) continue;
    orders.push({ good: goods[good], price, qty, tif: ioc ? "IOC" : "GTC" });
  }
  return { cancel_all: true, orders };
}

async function initWasmBot(wasm) {
  const { WASI, File, OpenFile, ConsoleStdout } = await import(WASI_SHIM_URL);
  const wasi = new WASI([], [], [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered(log),
    ConsoleStdout.lineBuffered(log),
  ]);
  const { instance } = await WebAssembly.instantiate(wasm, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  wasi.initialize(instance);
  const ex = instance.exports;
  ex.bot_init();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    kind: "wasm",
    tick(state) {
      const bytes = encoder.encode(stateToText(state));
      if (bytes.length > ex.bot_input_capacity()) throw new Error("state too large for the C harness");
      new Uint8Array(ex.memory.buffer, ex.bot_input(), bytes.length).set(bytes);
      const out = ex.bot_tick(bytes.length);
      const mem = new Uint8Array(ex.memory.buffer);
      let end = out;
      while (mem[end] !== 0) end++;
      return textToResponse(decoder.decode(mem.subarray(out, end)), state.goods);
    },
  };
}

const commands = {
  async init_python_bot({ source }) {
    const py = await getPyodide();
    await py.loadPackagesFromImports(source);
    bot?.py?.destroy?.();
    bot = { kind: "python", py: py.globals.get("_PyBot")(source) };
  },

  async init_wasm_bot({ wasm }) {
    bot = await initWasmBot(wasm);
  },

  tick({ state }) {
    if (!bot) throw new Error("bot not initialised");
    if (bot.kind === "python") return bot.py.tick_json(state);
    return JSON.stringify(bot.tick(JSON.parse(state)));
  },

  async init_backtest({ files, manifest, events }) {
    const py = await getPyodide();
    py.FS.mkdirTree("/home/pyodide/market_core");
    for (const [name, text] of Object.entries(files)) {
      py.FS.writeFile(`/home/pyodide/market_core/${name}`, text);
    }
    engine?.destroy?.();
    engine = py.globals.get("_start_backtest")(manifest, events);
  },

  async run_backtest({ maxTicks }, id) {
    const py = await getPyodide();
    if (!engine || !bot) throw new Error("backtest not initialised");
    // Pass `undefined`, not `null`: Pyodide maps undefined to None but null to JsNull.
    const jsTick = bot.kind === "wasm" ? (s) => JSON.stringify(bot.tick(JSON.parse(s))) : undefined;
    const progress = (n) => self.postMessage({ id, progress: n, logs: takeLogs() });
    const run = py.globals.get("_run_backtest");
    return run(engine, bot.kind === "python" ? bot.py : undefined, jsTick, maxTicks, 250, progress);
  },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try {
    const handler = commands[cmd];
    if (!handler) throw new Error(`unknown command ${cmd}`);
    const result = await handler(args ?? {}, id);
    self.postMessage({ id, ok: true, result, logs: takeLogs() });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err), logs: takeLogs() });
  }
};
