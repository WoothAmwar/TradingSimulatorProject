// Copies the browser-safe part of engine/market_core into public/py so in-browser backtests run
// exactly the matching code the live engine runs, and the Python bot SDK (engine/bot_sdk) so bots
// behave the same in the browser and on the engine. engine/tests/test_browser_copy.py fails if
// the copies drift, so run `npm run sync:engine` after changing those modules.
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_MODULES = [
  "__init__.py",
  "types.py",
  "book.py",
  "exchange.py",
  "driver.py",
  "protocol.py",
  "series.py",
  "backtest.py",
];

// wasi_main.py, the SDK's third file, only runs on the engine.
export const BOT_SDK_MODULES = ["trader_sdk.py", "bot_runner.py"];

const here = dirname(fileURLToPath(import.meta.url));

function copy(folder, files) {
  const src = join(here, "../../engine", folder);
  const dest = join(here, "../public/py", folder);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const file of files) copyFileSync(join(src, file), join(dest, file));
  writeFileSync(join(dest, "files.json"), JSON.stringify(files) + "\n");
  console.log(`copied ${readdirSync(dest).length - 1} modules to public/py/${folder}`);
}

copy("market_core", BROWSER_MODULES);
copy("bot_sdk", BOT_SDK_MODULES);
