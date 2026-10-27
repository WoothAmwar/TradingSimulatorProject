// Exercises lib/runtime/sandbox.ts and the worker scripts in real (headless) Chrome: sandboxed
// iframe, blob module workers, Pyodide and YoWASP Clang loaded from the CDN, and a backtest.
// Requires network access (jsDelivr) and Google Chrome.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json", ".py": "text/plain", ".gz": "application/gzip", ".c": "text/plain", ".cpp": "text/plain", ".h": "text/plain", ".hpp": "text/plain" };

const ts = (await import(join(WEB, "node_modules/typescript/lib/typescript.js"))).default;
const sandboxJs = ts.transpileModule(readFileSync(join(WEB, "lib/runtime/sandbox.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

let server, browser, page, origin, datasetDir;

before(async () => {
  datasetDir = join(mkdtempSync(join(tmpdir(), "browser-test-")), "ds");
  execFileSync("uv", ["run", "python", "-m", "scripts.make_dataset", "--seed", "7", "--ticks", "300", "--out", datasetDir], {
    cwd: resolve(WEB, "../engine"),
    stdio: "ignore",
  });
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file;
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<!doctype html><script type="module">window.sandbox = await import("/sandbox.js"); window.ready = true;</script>');
    }
    if (url.pathname === "/sandbox.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(sandboxJs);
    }
    file = url.pathname.startsWith("/dataset/") ? join(datasetDir, url.pathname.slice(9)) : join(WEB, "public", url.pathname);
    if (!existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(origin);
  await page.waitForFunction("window.ready === true");
});

after(async () => {
  await browser?.close();
  server?.close();
});

const PYTHON_TEMPLATE = (() => {
  const src = readFileSync(join(WEB, "lib/templates.ts"), "utf8");
  const body = src.slice(src.indexOf("export const TEMPLATES"));
  return new Function(`return (${body.slice(body.indexOf("{"), body.lastIndexOf("};") + 1)});`)();
})();

test("python bot runs in a sandboxed, opaque-origin worker", { timeout: 180_000 }, async () => {
  const out = await page.evaluate(async (source) => {
    const sb = await window.sandbox.getSandbox();
    const worker = sb.spawn(await window.sandbox.workerScript("/runtimes/bot-host.js"));
    await worker.call("init_python_bot", {
      source: source + "\nimport js\nprint('origin', js.self.location.origin)\n",
    });
    const state = {
      tick: 1, goods: ["X"], limits: { X: 10 }, cash: 0, position: { X: 0 }, open_orders: [], own_trades: [],
      order_depths: { X: { bids: [[95, 4]], asks: [[105, 2]] } }, market_trades: { X: [] },
    };
    const { result } = await worker.call("tick", { state: JSON.stringify(state) });
    const frame = document.querySelector("iframe");
    worker.terminate();
    return { result: JSON.parse(result), sandbox: frame.getAttribute("sandbox") };
  }, PYTHON_TEMPLATE.python);
  assert.equal(out.sandbox, "allow-scripts");
  assert.deepEqual(out.result, {
    cancel_all: true,
    orders: [
      { good: "X", price: 96, qty: 5, tif: "GTC" },
      { good: "X", price: 104, qty: -5, tif: "GTC" },
    ],
  });
});

test("participant code sees an opaque origin", { timeout: 120_000 }, async () => {
  const logs = await page.evaluate(async () => {
    const sb = await window.sandbox.getSandbox();
    const worker = sb.spawn(await window.sandbox.workerScript("/runtimes/bot-host.js"));
    const { logs } = await worker.call("init_python_bot", {
      source: "import js\nprint(js.self.location.origin)\nclass Trader:\n    def run(self, s):\n        return []\n",
    });
    worker.terminate();
    return logs;
  });
  assert.deepEqual(logs, ["null"]);
});

test("C bot compiles with the in-browser clang and backtests", { timeout: 600_000 }, async () => {
  const out = await page.evaluate(async (source) => {
    const sdk = Object.fromEntries(
      await Promise.all(
        ["trader.h", "harness.c", "trader.hpp", "harness.cpp"].map(async (f) => [f, await (await fetch(`/runtimes/sdk/${f}`)).text()]),
      ),
    );
    const sb = await window.sandbox.getSandbox();
    const cc = sb.spawn(await window.sandbox.workerScript("/runtimes/clang-compiler.js"));
    const { result: wasm } = await cc.call("compile", { language: "c", source, sdk });
    cc.terminate();

    const host = sb.spawn(await window.sandbox.workerScript("/runtimes/bot-host.js"));
    await host.call("init_wasm_bot", { wasm }, { transfer: [wasm.buffer] });
    const names = await (await fetch("/py/market_core/files.json")).json();
    const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await (await fetch(`/py/market_core/${n}`)).text()])));
    const manifest = await (await fetch("/dataset/manifest.json")).text();
    const events = new Uint8Array(await (await fetch("/dataset/events.jsonl.gz")).arrayBuffer());
    await host.call("init_backtest", { files, manifest, events }, { transfer: [events.buffer] });
    const { result } = await host.call("run_backtest", { maxTicks: 1e9 });
    host.terminate();
    return JSON.parse(result);
  }, PYTHON_TEMPLATE.c);
  assert.equal(out.ticks, 300);
  assert.deepEqual(out.errors, []);
  assert.ok(out.fills.length > 0);
});
