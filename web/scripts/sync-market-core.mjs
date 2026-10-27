// Copies the browser-safe part of engine/market_core into public/py so in-browser backtests run
// exactly the matching code the live engine runs. engine/tests/test_browser_copy.py fails if the
// copies drift, so run `npm run sync:engine` after changing those modules.
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
  "backtest.py",
];

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../../engine/market_core");
const dest = join(here, "../public/py/market_core");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const file of BROWSER_MODULES) copyFileSync(join(src, file), join(dest, file));
writeFileSync(join(dest, "files.json"), JSON.stringify(BROWSER_MODULES) + "\n");
console.log(`copied ${readdirSync(dest).length - 1} modules to public/py/market_core`);
