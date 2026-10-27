import type { Language } from "@/lib/templates";
import { getSandbox, workerScript, type RuntimeWorker } from "./sandbox";

export const SUPPORTED_LANGUAGES: Language[] = ["python", "c", "cpp"];

export class UnsupportedLanguage extends Error {}

export type StartStatus = (message: string) => void;

const SDK_FILES = ["trader.h", "harness.c", "trader.hpp", "harness.cpp"];
let sdkPromise: Promise<Record<string, string>> | null = null;
const compiled = new Map<string, Uint8Array>();

function loadSdk() {
  sdkPromise ??= Promise.all(
    SDK_FILES.map(async (f) => [f, await (await fetch(`/runtimes/sdk/${f}`)).text()] as const),
  ).then(Object.fromEntries);
  return sdkPromise;
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compiles C/C++ to WebAssembly in the sandbox; results are cached per source for the session. */
export async function compileNative(
  language: "c" | "cpp",
  source: string,
  onStatus: StartStatus,
): Promise<Uint8Array> {
  const sdk = await loadSdk();
  const key = await sha256(`${language}\0${source}\0${JSON.stringify(sdk)}`);
  const cached = compiled.get(key);
  if (cached) return cached.slice();

  const sandbox = await getSandbox();
  const worker = sandbox.spawn(await workerScript("/runtimes/clang-compiler.js"));
  try {
    onStatus("Compiling (first run downloads the ~25 MB compiler)…");
    const { result } = await worker.call<Uint8Array>(
      "compile",
      { language, source, sdk },
      {
        onProgress: (p) => {
          const { doneLength, totalLength } = p as { doneLength: number; totalLength: number };
          if (totalLength) onStatus(`Downloading compiler… ${Math.round((100 * doneLength) / totalLength)}%`);
        },
      },
    );
    compiled.set(key, result.slice());
    return result;
  } finally {
    worker.terminate();
  }
}

/** Starts a bot-host worker running `source`. The caller owns the worker and must terminate it. */
export async function startBot(
  language: Language,
  source: string,
  onStatus: StartStatus,
): Promise<{ worker: RuntimeWorker; logs: string[] }> {
  if (language !== "python" && language !== "c" && language !== "cpp") {
    const name = language === "go" ? "Go" : "Java";
    throw new UnsupportedLanguage(
      `${name} bots can be written and saved, but the in-browser ${name} runtime is not enabled yet.`,
    );
  }
  const sandbox = await getSandbox();
  const worker = sandbox.spawn(await workerScript("/runtimes/bot-host.js"));
  try {
    if (language === "python") {
      onStatus("Starting Python (first run downloads ~10 MB)…");
      const { logs } = await worker.call("init_python_bot", { source });
      return { worker, logs };
    }
    const wasm = await compileNative(language, source, onStatus);
    onStatus("Starting bot…");
    const { logs } = await worker.call("init_wasm_bot", { wasm }, { transfer: [wasm.buffer] });
    return { worker, logs };
  } catch (e) {
    worker.terminate();
    throw e;
  }
}
