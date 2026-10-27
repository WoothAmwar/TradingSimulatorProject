// Module worker that compiles a C or C++ bot to a WASI reactor module with YoWASP Clang
// (Clang/LLD built for WebAssembly, ~25 MiB, downloaded on first use and cached by the browser).

const CLANG_URL = "https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js";

let clangPromise = null;

self.onmessage = async ({ data }) => {
  const { id, args } = data;
  const { language, source, sdk } = args;
  let diagnostics = "";
  const decoder = new TextDecoder();
  const capture = (bytes) => {
    if (bytes) diagnostics += decoder.decode(bytes, { stream: true });
  };
  try {
    clangPromise ??= import(CLANG_URL);
    const { runClang } = await clangPromise;
    const isC = language === "c";
    const files = isC
      ? { "trader.h": sdk["trader.h"], "harness.c": sdk["harness.c"], "trader.c": source }
      : { "trader.hpp": sdk["trader.hpp"], "harness.cpp": sdk["harness.cpp"], "user_trader.cpp": source };
    const argv = isC
      ? ["clang", "-O2", "-mexec-model=reactor", "harness.c", "trader.c", "-o", "bot.wasm"]
      : ["clang++", "-O2", "-std=c++20", "-fno-exceptions", "-mexec-model=reactor", "harness.cpp", "-o", "bot.wasm"];
    const progress = ({ doneLength, totalLength }) =>
      self.postMessage({ id, progress: { doneLength, totalLength } });
    const out = await runClang(argv, files, {
      stdout: capture,
      stderr: capture,
      decodeASCII: false,
      fetchProgress: progress,
    });
    const wasm = out["bot.wasm"];
    self.postMessage({ id, ok: true, result: wasm, logs: diagnostics ? [diagnostics] : [] }, [wasm.buffer]);
  } catch (err) {
    const message = diagnostics.trim() || String(err?.message ?? err);
    self.postMessage({ id, ok: false, error: message, logs: [] });
  }
};
