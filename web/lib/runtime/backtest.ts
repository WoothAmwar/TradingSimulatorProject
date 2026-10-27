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
): Promise<{ result: BacktestResult; logs: string[] }> {
  const [dataset, files] = await Promise.all([loadDataset(lobbyId), loadEngineFiles()]);
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
  return { result: JSON.parse(result), logs };
}
