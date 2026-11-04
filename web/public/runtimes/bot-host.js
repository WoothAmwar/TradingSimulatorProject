// Module worker that runs one participant bot, and for backtests also the matching engine. It is
// created from a data: URL inside a sandboxed (opaque-origin) iframe, so user code cannot reach the
// page, its cookies or its storage. Requests: {id, cmd, args} -> {id, ok, result|error, logs}.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const WASI_SHIM_URL = "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js";

// The Python SDK (trader_sdk.py, bot_runner.py) is shared with the engine, which runs live bots
// in its own sandbox. The page passes those files in (public/py/bot_sdk, synced from the engine),
// so a bot behaves the same in a backtest and live.
const SDK_DIR = "/home/pyodide/bot_sdk";

const HARNESS = `
import json, sys, traceback

sys.path.insert(0, ${JSON.stringify(SDK_DIR)})


def _new_bot(source):
    import bot_runner
    return bot_runner.Bot(source)


def _start_backtest(manifest_json, events_gz):
    import gzip
    from market_core.backtest import make_backtest
    text = gzip.decompress(events_gz.to_bytes()).decode()
    events = [json.loads(line) for line in text.splitlines() if line]
    return make_backtest(json.loads(manifest_json), events, owner="you")


def _run_backtest(bt, py_bot, js_tick, max_ticks, every, progress):
    goods = list(bt.goods)
    series, fills, errors = [], [], []
    rejects = 0
    n = 0
    while n < max_ticks:
        state = bt.open_next()
        if state is None:
            break
        if py_bot is None and n > 0:
            # Compiled bots keep the price path from tick 0; resending it would cost O(ticks) a tick.
            state = {k: v for k, v in state.items() if k != "prices"}
        try:
            if py_bot is not None:
                response = py_bot.tick(state)
            else:
                response = json.loads(js_tick(json.dumps(state)) or "null")
        except Exception as exc:
            response = {"cancel_all": True, "orders": []}  # like live: a tick that fails cancels
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
                       "errors": errors, "ticks": n, "score": bt.score()})
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

// Flat text state for compiled bots (see public/runtimes/sdk/harness.c). Rounds trade one good.
// The engine runs live C/C++ bots with a copy of this and textToResponse (server/sandbox.py).
function stateToText(s) {
  const good = s.goods[0];
  const book = s.order_depths[good] ?? { bids: [], asks: [] };
  const trades = (s.market_trades[good] ?? []).map(([price, qty]) => [price, qty]);
  const lines = [
    `T ${s.tick} ${s.cash} ${s.position[good] ?? 0} ${s.limits[good] ?? 0}`,
    `B ${book.bids.length} ${book.bids.flat().join(" ")}`,
    `A ${book.asks.length} ${book.asks.flat().join(" ")}`,
    `X ${trades.length} ${trades.flat().join(" ")}`,
  ];
  const prices = s.prices?.[good];
  if (prices) lines.push(`P ${prices.length} ${prices.join(" ")}`);
  if (s.history) {
    // The prices the bot hasn't been sent yet, from index history_start on.
    const history = s.history[good] ?? [];
    lines.push(`H ${s.history_start ?? 0} ${history.length} ${history.join(" ")}`);
  }
  const lowest = s.min_positions?.[good];
  if (lowest !== undefined) lines.push(`M ${lowest}`);
  return lines.join("\n") + "\n";
}

// The harness writes one "price qty" line per order; they replace last tick's orders.
function textToResponse(text, good) {
  const orders = [];
  for (const line of text.split("\n")) {
    const [price, qty] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(price) && Number.isInteger(qty) && qty) orders.push({ good, price, qty });
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
      return textToResponse(decoder.decode(mem.subarray(out, end)), state.goods[0]);
    },
  };
}

const commands = {
  // Bots get Python's standard library only, as on the engine: no packages are loaded.
  async init_python_bot({ source, sdk }) {
    const py = await getPyodide();
    py.FS.mkdirTree(SDK_DIR);
    for (const [name, text] of Object.entries(sdk)) py.FS.writeFile(`${SDK_DIR}/${name}`, text);
    bot?.py?.destroy?.();
    bot = { kind: "python", py: py.globals.get("_new_bot")(source) };
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
