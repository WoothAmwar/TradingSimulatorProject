import { createClient } from "@/lib/supabase/client";
import type { RuntimeWorker } from "./sandbox";

export type BacktestResult = {
  goods: string[];
  /** [tick, pnl, ...position per good] */
  series: number[][];
  fills: { tick: number; good: string; price: number; qty: number }[];
  rejects: number;
  errors: { tick: number; error: string }[];
  ticks: number;
  /** Cash plus positions at the round's marks: the official result for a static round. */
  score: number;
};

type Dataset = { manifest: string; events: Uint8Array };
const datasets = new Map<string, Promise<Dataset>>();
let engineFiles: Promise<Record<string, string>> | null = null;

/** The lobby's public dataset (ticks 0..K-1) from Supabase Storage; cached for the session. */
export function loadDataset(lobbyId: string): Promise<Dataset> {
  if (!datasets.has(lobbyId)) {
    const load = (async () => {
      const storage = createClient().storage.from("datasets");
      const [manifest, events] = await Promise.all([
        storage.download(`${lobbyId}/manifest.json`),
        storage.download(`${lobbyId}/events.jsonl.gz`),
      ]);
      if (manifest.error || events.error) {
        throw new Error("This lobby's dataset is not available yet");
      }
      return {
        manifest: await manifest.data.text(),
        events: new Uint8Array(await events.data.arrayBuffer()),
      };
    })();
    load.catch(() => datasets.delete(lobbyId));
    datasets.set(lobbyId, load);
  }
  return datasets.get(lobbyId)!;
}

/** The price at each tick in a published prices.csv: the book's middle price in live datasets, the
 * single price in best-time rounds. Lobbies trade one good; for older two-good files, the first. */
export function parsePricePath(csv: string): [tick: number, price: number][] {
  const [header, ...rows] = csv.trim().split("\n");
  const cols = header.split(",");
  const tick = cols.indexOf("tick");
  const good = cols.indexOf("good");
  const price = cols.includes("mid_price") ? cols.indexOf("mid_price") : cols.indexOf("price");
  const first = rows[0]?.split(",")[good];
  return rows.flatMap((row) => {
    const cells = row.split(",");
    return cells[good] === first && cells[price] ? [[Number(cells[tick]), Number(cells[price])] as [number, number]] : [];
  });
}

const pricePaths = new Map<string, Promise<[tick: number, price: number][]>>();

/** A lobby's published prices (what bots see as state.price), for charts; cached for the session. */
export function loadPricePath(lobbyId: string): Promise<[tick: number, price: number][]> {
  if (!pricePaths.has(lobbyId)) {
    const load = (async () => {
      const { data, error } = await createClient().storage.from("datasets").download(`${lobbyId}/prices.csv`);
      if (error) throw new Error("This lobby's prices are not available yet");
      return parsePricePath(await data.text());
    })();
    load.catch(() => pricePaths.delete(lobbyId));
    pricePaths.set(lobbyId, load);
  }
  return pricePaths.get(lobbyId)!;
}

/** Saves one of a lobby's published data files (e.g. prices.csv) to the user's computer. */
export async function downloadDatasetFile(lobbyId: string, file: string): Promise<void> {
  const { data, error } = await createClient().storage.from("datasets").download(`${lobbyId}/${file}`);
  if (error) throw new Error(`${file} is not available for this round`);
  const url = URL.createObjectURL(data);
  Object.assign(document.createElement("a"), { href: url, download: file }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Browser copies of the engine's matching code (synced from engine/market_core). */
function loadEngineFiles() {
  engineFiles ??= (async () => {
    const names: string[] = await (await fetch("/py/market_core/files.json")).json();
    const entries = await Promise.all(
      names.map(async (n) => [n, await (await fetch(`/py/market_core/${n}`)).text()] as const),
    );
    return Object.fromEntries(entries);
  })();
  return engineFiles;
}

/** Replays the dataset through the real matching engine against the bot in `worker`. */
export async function runBacktest(
  worker: RuntimeWorker,
  lobbyId: string,
  maxTicks: number,
  onProgress: (ticks: number, logs: string[]) => void,
): Promise<{ result: BacktestResult; logs: string[]; seconds: number }> {
  const [dataset, files] = await Promise.all([loadDataset(lobbyId), loadEngineFiles()]);
  const started = performance.now();
  const events = dataset.events.slice(); // the copy is transferred to the worker
  await worker.call(
    "init_backtest",
    { files, manifest: dataset.manifest, events },
    { transfer: [events.buffer] },
  );
  const { result, logs } = await worker.call<string>(
    "run_backtest",
    { maxTicks },
    { onProgress: (n, l) => onProgress(n as number, l) },
  );
  return { result: JSON.parse(result), logs, seconds: (performance.now() - started) / 1000 };
}
