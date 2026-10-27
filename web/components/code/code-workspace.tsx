"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { saveSubmission } from "@/app/actions/group";
import { runBacktest, type BacktestResult } from "@/lib/runtime/backtest";
import { startBot, SUPPORTED_LANGUAGES } from "@/lib/runtime/bots";
import type { RuntimeWorker } from "@/lib/runtime/sandbox";
import { LANGUAGES, TEMPLATES, type Language } from "@/lib/templates";
import { CodeEditor } from "./code-editor";
import { appendLines, ConsoleView, type ConsoleLine } from "./console-view";
import { LineChart } from "./line-chart";

export type DatasetOption = { lobbyId: string; name: string; ticks: number };

type Draft = { title: string; language: Language; source: string };

export function CodeWorkspace({
  groupId,
  slug,
  datasets,
  initial,
}: {
  groupId: string;
  slug: string;
  datasets: DatasetOption[];
  initial: Draft | null;
}) {
  const draftKey = `draft:${groupId}`;
  // Client-only component (see code-workspace-loader), so localStorage is safe to read here.
  const [draft, setDraft] = useState<Draft>(
    () =>
      initial ??
      readDraft(draftKey) ?? { title: "My strategy", language: "python", source: TEMPLATES.python },
  );
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [lobbyId, setLobbyId] = useState(datasets[0]?.lobbyId ?? "");
  const [maxTicks, setMaxTicks] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const worker = useRef<RuntimeWorker | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify(draft));
      } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [draft, draftKey]);

  useEffect(() => () => worker.current?.terminate(), []);

  const log = (text: string | string[], kind: ConsoleLine["kind"] = "log") =>
    setLines((prev) => appendLines(prev, Array.isArray(text) ? text : [text], kind));

  const changeLanguage = (language: Language) => {
    const untouched = draft.source === TEMPLATES[draft.language];
    if (untouched || confirm(`Replace your code with the ${language} template?`)) {
      setDraft({ ...draft, language, source: TEMPLATES[language] });
    }
  };

  const save = () =>
    startSave(async () => {
      const r = await saveSubmission({ groupId, ...draft });
      if (r.ok) {
        setSavedId(r.value ?? null);
        setSaveError(null);
      } else setSaveError(r.error);
    });

  const backtest = async () => {
    setRunning(true);
    setResult(null);
    setProgress(0);
    setLines([]);
    const limit = maxTicks ? Number(maxTicks) : 1e9;
    try {
      const started = await startBot(draft.language, draft.source, setStatus);
      worker.current = started.worker;
      log(started.logs);
      setStatus("Running backtest…");
      const t0 = performance.now();
      const { result, logs } = await runBacktest(started.worker, lobbyId, limit, (n, l) => {
        setProgress(n);
        log(l);
      });
      log(logs);
      for (const e of result.errors) log(`tick ${e.tick}:\n${e.error}`, "error");
      log(`Backtest finished: ${result.ticks} ticks in ${((performance.now() - t0) / 1000).toFixed(1)}s`, "info");
      setResult(result);
    } catch (e) {
      const err = e as Error & { logs?: string[] };
      if (err.logs) log(err.logs);
      log(err.message, "error");
    } finally {
      worker.current?.terminate();
      worker.current = null;
      setRunning(false);
      setStatus(null);
    }
  };

  const stats = useMemo(() => summarize(result), [result]);
  const dataset = datasets.find((d) => d.lobbyId === lobbyId);
  const runnable = SUPPORTED_LANGUAGES.includes(draft.language);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-64"
            value={draft.title}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-label="Submission title"
          />
          <select
            className="input max-w-36"
            value={draft.language}
            onChange={(e) => changeLanguage(e.target.value as Language)}
            aria-label="Language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() =>
              confirm("Discard your changes and load the template?") &&
              setDraft({ ...draft, source: TEMPLATES[draft.language] })
            }
          >
            Reset to template
          </button>
          <button className="btn btn-primary ml-auto" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save submission"}
          </button>
        </div>
        {savedId && (
          <p className="text-sm text-bid">
            Saved. <Link href={`/g/${slug}/s/${savedId}`} className="underline">View submission</Link> or set
            it active for a lobby from the <Link href={`/g/${slug}`} className="underline">overview</Link>.
          </p>
        )}
        {saveError && <p className="text-sm text-ask">{saveError}</p>}
        <CodeEditor
          language={draft.language}
          value={draft.source}
          onChange={(source) => setDraft((d) => ({ ...d, source }))}
          height="calc(100vh - 16rem)"
        />
      </div>

      <div className="space-y-4">
        <section className="panel space-y-3 p-4">
          <h2 className="font-semibold">Backtest on local data</h2>
          {datasets.length === 0 ? (
            <p className="text-sm text-muted">No published datasets yet. An admin publishes one per lobby.</p>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_110px] gap-2">
                <select className="input" value={lobbyId} onChange={(e) => setLobbyId(e.target.value)}>
                  {datasets.map((d) => (
                    <option key={d.lobbyId} value={d.lobbyId}>
                      {d.name} ({d.ticks.toLocaleString()} ticks)
                    </option>
                  ))}
                </select>
                <input
                  className="input num"
                  placeholder="all ticks"
                  inputMode="numeric"
                  value={maxTicks}
                  onChange={(e) => setMaxTicks(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary" onClick={backtest} disabled={running || !runnable}>
                  {running ? "Running…" : "Run backtest"}
                </button>
                {running && (
                  <button className="btn" onClick={() => worker.current?.terminate()}>
                    Stop
                  </button>
                )}
              </div>
              {!runnable && (
                <p className="text-xs text-accent">
                  Saving works for every language; in-browser execution currently supports Python, C and C++.
                </p>
              )}
              {status && <p className="text-xs text-muted">{status}</p>}
              {running && dataset && (
                <div className="h-1.5 overflow-hidden rounded bg-panel-2">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${Math.min(100, (100 * progress) / Math.min(dataset.ticks, Number(maxTicks) || dataset.ticks))}%` }}
                  />
                </div>
              )}
              <p className="text-xs text-muted">
                Replays the lobby&apos;s published ticks through the same matching engine as the live market.
                The live market continues from where this data ends.
              </p>
            </>
          )}
        </section>

        {result && stats && (
          <section className="panel space-y-3 p-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Final PnL" value={stats.pnl.toFixed(0)} tone={stats.pnl >= 0 ? "text-bid" : "text-ask"} />
              <Stat label="Max drawdown" value={stats.drawdown.toFixed(0)} />
              <Stat label="Fills" value={String(result.fills.length)} />
              <Stat label="Rejected" value={String(result.rejects)} tone={result.rejects ? "text-accent" : ""} />
              <Stat label="Errors" value={String(result.errors.length)} tone={result.errors.length ? "text-ask" : ""} />
              <Stat
                label="Final position"
                value={result.goods.map((g, i) => `${g[0]}:${stats.position[i]}`).join(" ")}
              />
            </div>
            <LineChart points={stats.pnlPoints} />
            <p className="text-xs text-muted">
              PnL marks open positions at the mid price. Live scoring marks them at the hidden fair value.
            </p>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Console</h3>
          <ConsoleView lines={lines} />
        </section>
      </div>
    </div>
  );
}

function readDraft(key: string): Draft | null {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as Draft) : null;
  } catch {
    return null;
  }
}

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`num ${tone}`}>{value}</div>
    </div>
  );
}

function summarize(result: BacktestResult | null) {
  if (!result || result.series.length === 0) return null;
  let peak = -Infinity;
  let drawdown = 0;
  const pnlPoints: [number, number][] = [];
  for (const [tick, pnl] of result.series) {
    pnlPoints.push([tick, pnl]);
    peak = Math.max(peak, pnl);
    drawdown = Math.max(drawdown, peak - pnl);
  }
  const last = result.series[result.series.length - 1];
  return { pnl: last[1], drawdown, position: last.slice(2), pnlPoints };
}
