// Runs public/runtimes/*.js under Node worker_threads, with their CDN imports pointed at local
// copies of the same package versions. Checks that every runtime trades correctly and that the
// in-browser (Pyodide) backtest matches the native Python engine exactly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const ENGINE = resolve(WEB, "../engine");
const MODULES = join(HERE, "node_modules");
const tmp = mkdtempSync(join(tmpdir(), "runtime-tests-"));

const PREAMBLE = `import { parentPort } from "node:worker_threads";
globalThis.self = globalThis;
self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
parentPort.on("message", (data) => self.onmessage({ data }));
`;

function spawn(file, replacements) {
  let src = readFileSync(join(WEB, "public/runtimes", file), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(src.includes(from), `${file} no longer contains ${from}`);
    src = src.replaceAll(from, to);
  }
  const path = join(tmp, file.replace(/\.js$/, ".mjs"));
  writeFileSync(path, PREAMBLE + src);
  const worker = new Worker(path);
  const pending = new Map();
  let nextId = 1;
  worker.on("message", (m) => {
    if (m.progress !== undefined) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(Object.assign(new Error(m.error), { logs: m.logs }));
  });
  return {
    call(cmd, args, transfer = []) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, cmd, args }, transfer);
      });
    },
    terminate: () => worker.terminate(),
  };
}

const pyodideDir = join(MODULES, "pyodide") + "/";
const botHost = () =>
  spawn("bot-host.js", [
    ['import(PYODIDE_URL + "pyodide.mjs")', `import(${JSON.stringify(pathToFileURL(pyodideDir + "pyodide.mjs").href)})`],
    ["indexURL: PYODIDE_URL", `indexURL: ${JSON.stringify(pyodideDir)}`],
    [
      "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/dist/index.js",
      pathToFileURL(join(MODULES, "@bjorn3/browser_wasi_shim/dist/index.js")).href,
    ],
  ]);
const compiler = () =>
  spawn("clang-compiler.js", [
    [
      "https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js",
      pathToFileURL(join(MODULES, "@yowasp/clang/gen/bundle.js")).href,
    ],
  ]);

// The starter templates live in lib/templates.ts, which Node imports with its types stripped.
const { TEMPLATES, STATIC_TEMPLATES } = await import(pathToFileURL(join(WEB, "lib/templates.ts")).href);

const sdk = Object.fromEntries(
  ["trader.h", "harness.c", "trader.hpp", "harness.cpp"].map((f) => [
    f,
    readFileSync(join(WEB, "public/runtimes/sdk", f), "utf8"),
  ]),
);
// The Python SDK the browser shares with the engine (synced from engine/bot_sdk).
const pySdk = Object.fromEntries(
  JSON.parse(readFileSync(join(WEB, "public/py/bot_sdk/files.json"), "utf8")).map((f) => [
    f,
    readFileSync(join(WEB, "public/py/bot_sdk", f), "utf8"),
  ]),
);
const marketCore = Object.fromEntries(
  JSON.parse(readFileSync(join(WEB, "public/py/market_core/files.json"), "utf8")).map((f) => [
    f,
    readFileSync(join(WEB, "public/py/market_core", f), "utf8"),
  ]),
);

let dataset;
let bestTime;
let flatMean;
let host;

function makeDataset(name, ...args) {
  const out = join(tmp, name);
  execFileSync("uv", ["run", "python", "-m", "scripts.make_dataset", ...args, "--out", out], {
    cwd: ENGINE,
    stdio: "ignore",
  });
  return {
    dir: out,
    manifest: readFileSync(join(out, "manifest.json"), "utf8"),
    events: () => new Uint8Array(readFileSync(join(out, "events.jsonl.gz"))),
  };
}

before(() => {
  dataset = makeDataset("dataset", "--seed", "99", "--ticks", "400", "--good", "STABLE");
  bestTime = makeDataset("best-time", "--preset", "BEST_TIME", "--seed", "5");
  flatMean = makeDataset("flat-mean", "--preset", "FLAT_MEAN", "--seed", "5", "--ticks", "400");
  host = botHost();
});

after(() => host?.terminate());

async function backtest(initBot, data = dataset) {
  await initBot(host);
  await host.call("init_backtest", { files: marketCore, manifest: data.manifest, events: data.events() });
  const { result, logs } = await host.call("run_backtest", { maxTicks: 1e9 });
  return { ...JSON.parse(result), logs };
}

function nativeBacktest(source, data = dataset) {
  // Run the worker's own Python harness under CPython with the engine's market_core and bot_sdk.
  const worker = readFileSync(join(WEB, "public/runtimes/bot-host.js"), "utf8");
  const decls = worker.slice(worker.indexOf("const SDK_DIR"), worker.indexOf("let logs"));
  writeFileSync(join(tmp, "harness.py"), new Function(`${decls}; return HARNESS;`)());
  writeFileSync(join(tmp, "bot.py"), source);
  const script = `
import json, sys
sys.path.insert(0, sys.argv[5])
ns = {}
exec(open(sys.argv[1]).read(), ns)
class Bytes(bytes):
    def to_bytes(self): return bytes(self)
bt = ns["_start_backtest"](open(sys.argv[3]).read(), Bytes(open(sys.argv[4], "rb").read()))
print(ns["_run_backtest"](bt, ns["_new_bot"](open(sys.argv[2]).read()), None, 10**9, 10**9, lambda n: None))
`;
  const out = execFileSync(
    "uv",
    ["run", "python", "-c", script, join(tmp, "harness.py"), join(tmp, "bot.py"),
      join(data.dir, "manifest.json"), join(data.dir, "events.jsonl.gz"), join(ENGINE, "bot_sdk")],
    { cwd: ENGINE, encoding: "utf8" },
  );
  return JSON.parse(out);
}

let pythonResult;

test("python template backtest in Pyodide matches the native engine exactly", { timeout: 300_000 }, async () => {
  const source = TEMPLATES.python;
  pythonResult = await backtest((h) => h.call("init_python_bot", { sdk: pySdk, source }));
  assert.equal(pythonResult.ticks, 400);
  assert.deepEqual(pythonResult.errors, []);
  assert.ok(pythonResult.fills.length > 0, "the template should trade");
  const native = nativeBacktest(source);
  assert.deepEqual(pythonResult.series, native.series);
  assert.deepEqual(pythonResult.fills, native.fills);
});

test("python live tick, print() capture and error reporting", { timeout: 120_000 }, async () => {
  const state = {
    tick: 5, goods: ["X"], limits: { X: 10 }, cash: 0, position: { X: 0 }, open_orders: [],
    own_trades: [{ good: "X", price: 101, qty: -1, maker: true }],
    order_depths: { X: { bids: [[99, 4]], asks: [[102, 2]] } }, market_trades: { X: [[101, 1, 1]] },
  };
  await host.call("init_python_bot", { sdk: pySdk,
    source: `from trader_sdk import buy, sell\nclass Trader:\n    def run(self, s):\n        print(s.tick, s.price, s.position, s.limit, s.trades, s.my_trades)\n        return [buy(s.price, 2), sell(103, 1)]\n`,
  });
  const { result, logs } = await host.call("tick", { state: JSON.stringify(state) });
  assert.deepEqual(JSON.parse(result), {
    cancel_all: true,
    orders: [{ good: "X", price: 100, qty: 2 }, { good: "X", price: 103, qty: -1 }], // 100.5 rounds to 100
  });
  assert.deepEqual(logs, ["5 100.5 0 10 [(101, 1)] [(101, -1)]"]);

  // Returning nothing, or a single order, works too.
  await host.call("init_python_bot", { sdk: pySdk, source: "from trader_sdk import buy\nclass Trader:\n    def run(self, s):\n        return buy(99)\n" });
  assert.deepEqual(JSON.parse((await host.call("tick", { state: JSON.stringify(state) })).result), {
    cancel_all: true, orders: [{ good: "X", price: 99, qty: 1 }],
  });
  await host.call("init_python_bot", { sdk: pySdk, source: "class Trader:\n    def run(self, s):\n        pass\n" });
  assert.deepEqual(JSON.parse((await host.call("tick", { state: JSON.stringify(state) })).result), {
    cancel_all: true, orders: [],
  });

  await host.call("init_python_bot", { sdk: pySdk, source: "class Trader:\n    def run(self, s):\n        return 1 / 0\n" });
  await assert.rejects(host.call("tick", { state: JSON.stringify(state) }), /ZeroDivisionError/);
  // Code written for the old multi-good API is pointed at the template.
  await host.call("init_python_bot", { sdk: pySdk, source: "class Trader:\n    def run(self, s):\n        return s.goods\n" });
  await assert.rejects(host.call("tick", { state: JSON.stringify(state) }), /state has no 'goods'\..*old bot API/);
  await assert.rejects(host.call("init_python_bot", { sdk: pySdk, source: "x = (" }), /SyntaxError/);
  await assert.rejects(host.call("init_python_bot", { sdk: pySdk, source: "y = 1" }), /class named Trader/);
  // Live bots run on the engine, which has only the standard library; backtests match it.
  for (const name of ["numpy", "js", "pyodide"]) {
    await assert.rejects(
      host.call("init_python_bot", { sdk: pySdk, source: `import ${name}\nclass Trader: pass\n` }),
      /only Python's standard library/,
    );
  }
});

// States a live bot might see: a wide book, a tight one, a one-sided one and an empty one, with
// different positions, so each template takes every branch.
const LIVE_STATES = [
  [[[9998, 12], [9997, 5]], [[10003, 9]], 0],
  [[[10000, 3]], [[10002, 4]], 10],
  [[[9990, 1]], [[10010, 1]], 50],
  [[[9990, 1]], [], -50],
  [[], [], 0],
].map(([bids, asks, position], i) => ({
  tick: 10_000 + i, goods: ["STABLE"], limits: { STABLE: 50 }, cash: -40_012 * i,
  position: { STABLE: position }, open_orders: [], own_trades: [], fees_paid: 0,
  order_depths: { STABLE: { bids, asks } }, market_trades: { STABLE: [[10001, 3, 1]] },
}));

/** Runs a bot in the engine's own sandbox (engine/server/sandbox.py); one reply per state. */
function engineReplies(language, file, states) {
  const out = execFileSync("uv", ["run", "python", "-m", "server.sandbox", "run", language, file], {
    cwd: ENGINE,
    encoding: "utf8",
    input: states.map((s) => JSON.stringify(s)).join("\n") + "\n",
  });
  const [ready, ...replies] = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(ready.ready, true, JSON.stringify(ready));
  return replies;
}

test("the engine runs every live template exactly as the browser does", { timeout: 600_000 }, async (t) => {
  if (!existsSync(join(ENGINE, "wasi-python/python.wasm"))) {
    t.skip("CPython for WASI isn't installed (python -m server.wasi_python install)");
    return;
  }
  const browserReplies = async () =>
    Promise.all(LIVE_STATES.map(async (s) => JSON.parse((await host.call("tick", { state: JSON.stringify(s) })).result)));

  writeFileSync(join(tmp, "live.py"), TEMPLATES.python);
  await host.call("init_python_bot", { sdk: pySdk, source: TEMPLATES.python });
  const expected = await browserReplies();
  assert.ok(expected.some((r) => r.orders.length), "the template should quote somewhere");
  const python = engineReplies("python", join(tmp, "live.py"), LIVE_STATES);
  assert.deepEqual(python.map((r) => r.error), LIVE_STATES.map(() => null));
  assert.deepEqual(python.map((r) => r.response), expected);

  const cc = compiler();
  try {
    for (const language of ["c", "cpp"]) {
      const { result: wasm } = await cc.call("compile", { language, source: TEMPLATES[language], sdk });
      writeFileSync(join(tmp, `live-${language}.wasm`), wasm);
      await host.call("init_wasm_bot", { wasm: wasm.slice() });
      assert.deepEqual(await browserReplies(), expected, `${language} in the browser`);
      const replies = engineReplies(language, join(tmp, `live-${language}.wasm`), LIVE_STATES);
      assert.deepEqual(replies.map((r) => r.response), expected, `${language} on the engine`);
    }
  } finally {
    await cc.terminate();
  }
});

// The same bot in every language: prints the helpers' values now and then and trades on
// price_stats() of the last 20 prices.
const STATS_BOTS = {
  python: `from trader_sdk import buy, sell, price_stats

class Trader:
    def run(self, s):
        average, stdev = price_stats(s.history, last=20)
        if s.tick % 10 == 0:
            last = s.history[-1] if s.history else 0
            print(f"{s.tick} {len(s.history)} {last:.1f} {average or 0:.6f} {stdev or 0:.6f} "
                  f"{s.best_bid or 0} {s.best_ask or 0} {s.can_buy} {s.can_sell}")
        if len(s.history) < 20:
            return []
        orders = []
        if s.can_buy > 0:
            orders.append(buy(int(average - stdev), min(3, s.can_buy)))
        if s.can_sell > 0:
            orders.append(sell(int(average + stdev) + 1, min(3, s.can_sell)))
        return orders
`,
  c: `#include <stdio.h>
#include "trader.h"

void trader_init(void) {}

void trader_run(const State *s, Orders *out) {
    PriceStats st = price_stats(s->history, s->num_history, 20);
    if (s->tick % 10 == 0) {
        double last = s->num_history ? s->history[s->num_history - 1] : 0;
        printf("%d %d %.1f %.6f %.6f %d %d %d %d\\n", s->tick, s->num_history, last, st.average,
               st.stdev, s->best_bid, s->best_ask, s->can_buy, s->can_sell);
    }
    if (s->num_history < 20) return;
    if (s->can_buy > 0) buy(out, (int)(st.average - st.stdev), s->can_buy < 3 ? s->can_buy : 3);
    if (s->can_sell > 0) sell(out, (int)(st.average + st.stdev) + 1, s->can_sell < 3 ? s->can_sell : 3);
}
`,
  cpp: `#include "trader.hpp"
#include <algorithm>
#include <cstdio>

class Trader {
public:
    std::vector<Order> run(const State& s) {
        PriceStats st = price_stats(s.history, 20);
        if (s.tick % 10 == 0) {
            char line[200];
            std::snprintf(line, sizeof line, "%d %d %.1f %.6f %.6f %d %d %d %d", s.tick,
                          (int)s.history.size(), s.history.empty() ? 0.0 : s.history.back(),
                          st.average, st.stdev, s.best_bid, s.best_ask, s.can_buy, s.can_sell);
            std::cout << line << "\\n";
        }
        if (s.history.size() < 20) return {};
        std::vector<Order> orders;
        if (s.can_buy > 0) orders.push_back(buy((int)(st.average - st.stdev), std::min(3, s.can_buy)));
        if (s.can_sell > 0) orders.push_back(sell((int)(st.average + st.stdev) + 1, std::min(3, s.can_sell)));
        return orders;
    }
};
`,
};

test("history, price_stats and the state shortcuts agree in Python, C and C++", { timeout: 600_000 }, async (t) => {
  // Under 250 ticks, so every printed line comes back with the final reply.
  const run = async (init) => {
    await init(host);
    await host.call("init_backtest", { files: marketCore, manifest: dataset.manifest, events: dataset.events() });
    const { result, logs } = await host.call("run_backtest", { maxTicks: 240 });
    return { ...JSON.parse(result), logs };
  };
  const python = await run((h) => h.call("init_python_bot", { sdk: pySdk, source: STATS_BOTS.python }));
  assert.deepEqual(python.errors, []);
  assert.equal(python.logs.length, 24);
  assert.ok(python.fills.length > 0, "the stats bot should trade");
  assert.match(python.logs[0], /^0 0 0\.0 0\.000000 0\.000000 \d+ \d+ 50 50$/);
  assert.match(python.logs[3], /^30 30 \d+\.\d \d+\.\d{6} \d+\.\d{6} /);

  // Live states: the whole history first, then one new price a tick, as the engine sends them.
  const prices = Array.from({ length: 30 }, (_, i) => 10_000 + ((i * 7) % 11) - 5 + (i % 2) / 2);
  const states = LIVE_STATES.map((s, i) => ({
    ...s,
    history_start: i ? 24 + i : 0,
    history: { STABLE: i ? [prices[24 + i]] : prices.slice(0, 25) },
  }));
  await host.call("init_python_bot", { sdk: pySdk, source: STATS_BOTS.python });
  const expected = [];
  for (const s of states) expected.push(JSON.parse((await host.call("tick", { state: JSON.stringify(s) })).result));
  assert.ok(expected.some((r) => r.orders.length));
  const onEngine = existsSync(join(ENGINE, "wasi-python/python.wasm"));
  if (onEngine) {
    writeFileSync(join(tmp, "stats.py"), STATS_BOTS.python);
    assert.deepEqual(engineReplies("python", join(tmp, "stats.py"), states).map((r) => r.response), expected);
  } else {
    t.diagnostic("CPython for WASI isn't installed: skipping the engine's Python run");
  }

  const cc = compiler();
  try {
    for (const language of ["c", "cpp"]) {
      const { result: wasm } = await cc.call("compile", { language, source: STATS_BOTS[language], sdk });
      const compiled = await run((h) => h.call("init_wasm_bot", { wasm: wasm.slice() }));
      assert.deepEqual(compiled.errors, [], language);
      assert.deepEqual(compiled.logs, python.logs, language);
      assert.deepEqual(compiled.series, python.series, language);

      await host.call("init_wasm_bot", { wasm: wasm.slice() });
      const replies = [];
      for (const s of states) replies.push(JSON.parse((await host.call("tick", { state: JSON.stringify(s) })).result));
      assert.deepEqual(replies, expected, `${language} in the browser`);
      writeFileSync(join(tmp, `stats-${language}.wasm`), wasm);
      const engine = engineReplies(language, join(tmp, `stats-${language}.wasm`), states);
      assert.deepEqual(engine.map((r) => r.response), expected, `${language} on the engine`);
    }
  } finally {
    await cc.terminate();
  }
});

for (const language of ["c", "cpp"]) {
  test(`${language} template compiles in the browser toolchain and trades like the python template`, { timeout: 600_000 }, async () => {
    const cc = compiler();
    try {
      const { result: wasm } = await cc.call("compile", { language, source: TEMPLATES[language], sdk });
      assert.ok(wasm.byteLength > 1000);
      const result = await backtest((h) => h.call("init_wasm_bot", { wasm }));
      assert.deepEqual(result.errors, []);
      assert.ok(pythonResult, "python test must run first");
      assert.deepEqual(result.series, pythonResult.series);
      assert.deepEqual(result.fills, pythonResult.fills);

      await assert.rejects(
        cc.call("compile", { language, source: "this is not valid code", sdk }),
        /error/,
      );
    } finally {
      await cc.terminate();
    }
  });
}

for (const preset of ["BEST_TIME", "FLAT_MEAN"]) {
  test(`${preset} static templates trade identically in Python, C and C++`, { timeout: 600_000 }, async () => {
    const data = preset === "BEST_TIME" ? bestTime : flatMean;
    const templates = STATIC_TEMPLATES[preset];
    const python = await backtest((h) => h.call("init_python_bot", { sdk: pySdk, source: templates.python }), data);
    assert.deepEqual(python.errors, []);
    assert.equal(python.rejects, 0);
    assert.deepEqual(python.series, nativeBacktest(templates.python, data).series);
    if (preset === "BEST_TIME") assert.equal(python.fills.length, 2, "one buy, then one sell");
    else assert.ok(python.score > 0, "quoting inside the bot's spread should earn the spread");
    const cc = compiler();
    try {
      for (const language of ["c", "cpp"]) {
        const { result: wasm } = await cc.call("compile", { language, source: templates[language], sdk });
        const result = await backtest((h) => h.call("init_wasm_bot", { wasm }), data);
        assert.deepEqual(result.errors, [], language);
        assert.deepEqual(result.series, python.series, language);
        assert.equal(result.score, python.score, language);
      }
    } finally {
      await cc.terminate();
    }
  });
}
