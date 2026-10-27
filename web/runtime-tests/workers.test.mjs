// Runs public/runtimes/*.js under Node worker_threads, with their CDN imports pointed at local
// copies of the same package versions. Checks that every runtime trades correctly and that the
// in-browser (Pyodide) backtest matches the native Python engine exactly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// The starter templates live in lib/templates.ts; evaluate that object literal.
function templates() {
  const src = readFileSync(join(WEB, "lib/templates.ts"), "utf8");
  const body = src.slice(src.indexOf("export const TEMPLATES"));
  const literal = body.slice(body.indexOf("{"), body.lastIndexOf("};") + 1);
  return new Function(`return (${literal});`)();
}

const sdk = Object.fromEntries(
  ["trader.h", "harness.c", "trader.hpp", "harness.cpp"].map((f) => [
    f,
    readFileSync(join(WEB, "public/runtimes/sdk", f), "utf8"),
  ]),
);
const marketCore = Object.fromEntries(
  JSON.parse(readFileSync(join(WEB, "public/py/market_core/files.json"), "utf8")).map((f) => [
    f,
    readFileSync(join(WEB, "public/py/market_core", f), "utf8"),
  ]),
);

let dataset;
let host;

before(() => {
  const out = join(tmp, "dataset");
  execFileSync("uv", ["run", "python", "-m", "scripts.make_dataset", "--seed", "99", "--ticks", "400", "--out", out], {
    cwd: ENGINE,
    stdio: "ignore",
  });
  dataset = {
    dir: out,
    manifest: readFileSync(join(out, "manifest.json"), "utf8"),
    events: () => new Uint8Array(readFileSync(join(out, "events.jsonl.gz"))),
  };
  host = botHost();
});

after(() => host?.terminate());

async function backtest(initBot) {
  await initBot(host);
  await host.call("init_backtest", { files: marketCore, manifest: dataset.manifest, events: dataset.events() });
  const { result, logs } = await host.call("run_backtest", { maxTicks: 1e9 });
  return { ...JSON.parse(result), logs };
}

function nativeBacktest(source) {
  // Run the worker's own Python harness under CPython with the engine's market_core.
  const worker = readFileSync(join(WEB, "public/runtimes/bot-host.js"), "utf8");
  const decls = worker.slice(worker.indexOf("const SDK_SOURCE"), worker.indexOf("let logs"));
  writeFileSync(join(tmp, "harness.py"), new Function(`${decls}; return HARNESS;`)());
  writeFileSync(join(tmp, "bot.py"), source);
  const script = `
import json, sys
ns = {}
exec(open(sys.argv[1]).read(), ns)
class Bytes(bytes):
    def to_bytes(self): return bytes(self)
bt = ns["_start_backtest"](open(sys.argv[3]).read(), Bytes(open(sys.argv[4], "rb").read()))
print(ns["_run_backtest"](bt, ns["_PyBot"](open(sys.argv[2]).read()), None, 10**9, 10**9, lambda n: None))
`;
  const out = execFileSync(
    "uv",
    ["run", "python", "-c", script, join(tmp, "harness.py"), join(tmp, "bot.py"),
      join(dataset.dir, "manifest.json"), join(dataset.dir, "events.jsonl.gz")],
    { cwd: ENGINE, encoding: "utf8" },
  );
  return JSON.parse(out);
}

let pythonResult;

test("python template backtest in Pyodide matches the native engine exactly", { timeout: 300_000 }, async () => {
  const source = templates().python;
  pythonResult = await backtest((h) => h.call("init_python_bot", { source }));
  assert.equal(pythonResult.ticks, 400);
  assert.deepEqual(pythonResult.errors, []);
  assert.ok(pythonResult.fills.length > 0, "the template should trade");
  const native = nativeBacktest(source);
  assert.deepEqual(pythonResult.series, native.series);
  assert.deepEqual(pythonResult.fills, native.fills);
});

test("python live tick, print() capture and error reporting", { timeout: 120_000 }, async () => {
  const state = {
    tick: 5, goods: ["X"], limits: { X: 10 }, cash: 0, position: { X: 0 }, open_orders: [], own_trades: [],
    order_depths: { X: { bids: [[99, 4]], asks: [[103, 2]] } }, market_trades: { X: [[101, 1, 1]] },
  };
  await host.call("init_python_bot", {
    source: `from trader_sdk import Order, Response\nclass Trader:\n    def run(self, s):\n        print("tick", s.tick, s.market_trades["X"])\n        return Response(orders=[Order("X", 100.0, 2)])\n`,
  });
  const { result, logs } = await host.call("tick", { state: JSON.stringify(state) });
  assert.deepEqual(JSON.parse(result), {
    orders: [{ good: "X", price: 100, qty: 2, tif: "GTC" }], cancel: [], cancel_all: false,
  });
  assert.deepEqual(logs, ["tick 5 [(101, 1, 1)]"]);

  await host.call("init_python_bot", { source: "class Trader:\n    def run(self, s):\n        return 1 / 0\n" });
  await assert.rejects(host.call("tick", { state: JSON.stringify(state) }), /ZeroDivisionError/);
  await assert.rejects(host.call("init_python_bot", { source: "x = (" }), /SyntaxError/);
  await assert.rejects(host.call("init_python_bot", { source: "y = 1" }), /class named Trader/);
});

for (const language of ["c", "cpp"]) {
  test(`${language} template compiles in the browser toolchain and trades like the python template`, { timeout: 600_000 }, async () => {
    const cc = compiler();
    try {
      const { result: wasm } = await cc.call("compile", { language, source: templates()[language], sdk });
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
