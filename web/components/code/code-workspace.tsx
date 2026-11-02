"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { saveSubmission, submitRoundScore } from "@/app/actions/group";
import { STATIC_PRESETS, STATUS_STYLES, statusLabel, type StaticPreset } from "@/lib/lobby";
import { downloadDatasetFile, loadPricePath, runBacktest, type BacktestResult } from "@/lib/runtime/backtest";
import { startBot } from "@/lib/runtime/bots";
import type { RuntimeWorker } from "@/lib/runtime/sandbox";
import { isLanguage, LANGUAGES, templateFor, type CodeTarget, type Language } from "@/lib/templates";
import { CodeEditor } from "./code-editor";
import { appendLines, ConsoleView, type ConsoleLine } from "./console-view";
import { LineChart } from "./line-chart";

export type DatasetOption = { lobbyId: string; name: string; ticks: number };

/** A published static round the group can write code for. */
export type RoundOption = {
  id: string;
  name: string;
  preset: StaticPreset;
  status: string;
  ticks: number;
  preview?: Record<string, [tick: number, price: number][]>;
};

type Draft = { title: string; language: Language; source: string };

const LIVE_FILES = ["prices.csv", "trades.csv"];

export function CodeWorkspace({
  groupId,
  slug,
  datasets,
  rounds,
  initialRound,
  initial,
}: {
  groupId: string;
  slug: string;
  datasets: DatasetOption[];
  rounds: RoundOption[];
  /** The static round to open, or null for live-market code. */
  initialRound: string | null;
  initial: Draft | null;
}) {
  // Each target (the live market or one static round) keeps its own draft, template and data.
  const targetOf = (id: string | null): CodeTarget => {
    const r = rounds.find((x) => x.id === id);
    return r ? { kind: "static", preset: r.preset } : { kind: "live" };
  };
  const keyOf = (id: string | null) => (id ? `draft:${groupId}:${id}` : `draft:${groupId}`);
  // Client-only component (see code-workspace-loader), so localStorage is safe to read here.
  const loadDraft = (id: string | null): Draft => {
    const target = targetOf(id);
    const stored = readDraft(keyOf(id));
    if (stored && isLanguage(stored.language)) return stored;
    const title = target.kind === "live" ? "My strategy" : `${STATIC_PRESETS[target.preset].name} solution`;
    return { title, language: "python", source: templateFor(target, "python") };
  };

  const [roundId, setRoundId] = useState<string | null>(initialRound);
  const [draft, setDraft] = useState<Draft>(() => initial ?? loadDraft(initialRound));
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [lobbyId, setLobbyId] = useState(datasets[0]?.lobbyId ?? "");
  const [maxTicks, setMaxTicks] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scored, setScored] = useState<{ score: number; rank: number } | null>(null);
  // Price charts of live datasets, by lobby id: the points, or an error message.
  const [pricePaths, setPricePaths] = useState<Record<string, [number, number][] | string>>({});
  const [saving, startSave] = useTransition();
  const worker = useRef<RuntimeWorker | null>(null);

  const round = rounds.find((r) => r.id === roundId) ?? null;
  const target = targetOf(roundId);
  const draftKey = keyOf(roundId);
  const dataLobbyId = round ? round.id : lobbyId;
  const dataTicks = round ? round.ticks : datasets.find((d) => d.lobbyId === lobbyId)?.ticks;

  useEffect(() => {
    const t = setTimeout(() => writeDraft(draftKey, draft), 500);
    return () => clearTimeout(t);
  }, [draft, draftKey]);

  useEffect(() => () => worker.current?.terminate(), []);

  useEffect(() => {
    if (round || !lobbyId || pricePaths[lobbyId]) return;
    loadPricePath(lobbyId).then(
      (points) => setPricePaths((p) => ({ ...p, [lobbyId]: points })),
      (e: Error) => setPricePaths((p) => ({ ...p, [lobbyId]: e.message })),
    );
  }, [round, lobbyId, pricePaths]);

  const log = (text: string | string[], kind: ConsoleLine["kind"] = "log") =>
    setLines((prev) => appendLines(prev, Array.isArray(text) ? text : [text], kind));

  const switchRound = (id: string | null) => {
    writeDraft(draftKey, draft); // the debounced save would be cancelled by the switch
    setRoundId(id);
    setDraft(loadDraft(id));
    setResult(null);
    setSavedId(null);
    setSaveError(null);
    setScored(null);
    setLines([]);
    window.history.replaceState(null, "", `/g/${slug}/code${id ? `?round=${id}` : ""}`);
  };

  const changeLanguage = (language: Language) => {
    const untouched = draft.source === templateFor(target, draft.language);
    if (untouched || confirm(`Replace your code with the ${language} template?`)) {
      setDraft({ ...draft, language, source: templateFor(target, language) });
    }
  };

  const save = () =>
    startSave(async () => {
      const r = await saveSubmission({ groupId, ...draft, lobbyId: round?.id ?? null });
      if (r.ok) {
        setSavedId(r.value ?? null);
        setSaveError(null);
      } else setSaveError(r.error);
    });

  /** Runs `code` against a lobby's published data; returns the result, or null if it failed. */
  const execute = async (code: Draft, dataLobby: string, limit: number) => {
    setRunning(true);
    setResult(null);
    setProgress(0);
    setLines([]);
    try {
      const started = await startBot(code.language, code.source, setStatus);
      worker.current = started.worker;
      log(started.logs);
      setStatus("Running backtest…");
      const { result, logs, seconds } = await runBacktest(started.worker, dataLobby, limit, (n, l) => {
        setProgress(n);
        log(l);
      });
      log(logs);
      for (const e of result.errors) log(`tick ${e.tick}:\n${e.error}`, "error");
      log(`Backtest finished: ${result.ticks} ticks in ${seconds.toFixed(1)}s`, "info");
      setResult(result);
      return result;
    } catch (e) {
      const err = e as Error & { logs?: string[] };
      if (err.logs) log(err.logs);
      log(err.message, "error");
      return null;
    } finally {
      worker.current?.terminate();
      worker.current = null;
      setRunning(false);
      setStatus(null);
    }
  };

  const backtest = () => execute(draft, dataLobbyId, maxTicks ? Number(maxTicks) : 1e9);

  /** Saves the code as a new submission, runs it over the whole round and records the score. */
  const submit = async () => {
    if (!round) return;
    const code = draft;
    setSubmitting(true);
    setScored(null);
    try {
      const saved = await saveSubmission({ groupId, ...code, lobbyId: round.id });
      if (!saved.ok || !saved.value) {
        setSaveError(saved.ok ? "Saving failed" : saved.error);
        return;
      }
      setSavedId(saved.value);
      setSaveError(null);
      const result = await execute(code, round.id, 1e9);
      if (!result) return;
      if (result.ticks !== round.ticks) {
        log(`The run stopped after ${result.ticks} of ${round.ticks} ticks, so it was not submitted.`, "error");
        return;
      }
      const r = await submitRoundScore({
        lobbyId: round.id,
        submissionId: saved.value,
        score: result.score,
        ticks: result.ticks,
        fills: result.fills.length,
      });
      if (r.ok) {
        setScored({ score: result.score, rank: Number(r.value) });
        log(`Submitted: score ${formatScore(result.score)}, rank #${r.value}.`, "info");
      } else log(`The score was not recorded: ${r.error}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const download = (file: string) =>
    downloadDatasetFile(dataLobbyId, file).catch((e: Error) => log(e.message, "error"));

  const stats = useMemo(() => summarize(result), [result]);
  const busy = running || submitting;
  const preview = round ? Object.values(round.preview ?? {})[0] : undefined;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_440px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input max-w-64"
            value={roundId ?? ""}
            disabled={busy}
            onChange={(e) => switchRound(e.target.value || null)}
            aria-label="Round"
          >
            <option value="">Live market</option>
            {rounds.map((r) => (
              <option key={r.id} value={r.id}>
                Static: {r.name} ({statusLabel("static", r.status)})
              </option>
            ))}
          </select>
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
              setDraft({ ...draft, source: templateFor(target, draft.language) })
            }
          >
            Reset to template
          </button>
          <button className="btn btn-primary ml-auto" onClick={save} disabled={saving || busy}>
            {saving ? "Saving…" : "Save submission"}
          </button>
        </div>
        {round && (
          <p className="text-xs text-muted">
            Code for <span className="text-foreground">{round.name}</span>, saved separately from your live code.
          </p>
        )}
        {savedId && (
          <p className="text-sm text-bid">
            Saved. <Link href={`/g/${slug}/s/${savedId}`} className="underline">View submission</Link>
            {!round && (
              <>
                {" "}
                or set it active for a lobby from the <Link href={`/g/${slug}`} className="underline">overview</Link>
              </>
            )}
            .
          </p>
        )}
        {saveError && <p className="text-sm text-ask">{saveError}</p>}
        <CodeEditor
          language={draft.language}
          value={draft.source}
          onChange={(source) => setDraft((d) => ({ ...d, source }))}
          height="calc(100vh - 17rem)"
        />
      </div>

      <div className="space-y-4">
        {round && (
          <section className="panel space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{round.name}</h2>
                <p className="text-xs text-muted">
                  {STATIC_PRESETS[round.preset].name} · {round.ticks.toLocaleString()} ticks
                </p>
              </div>
              <span className={`badge ${STATUS_STYLES[round.status]}`}>{statusLabel("static", round.status)}</span>
            </div>
            <p className="text-sm text-foreground/80">{STATIC_PRESETS[round.preset].description}</p>
            {preview && <LineChart points={preview} color="#f0b429" height={150} />}
            <div className="flex flex-wrap gap-2">
              {STATIC_PRESETS[round.preset].files.map((file) => (
                <button key={file} className="btn" onClick={() => download(file)}>
                  Download {file}
                </button>
              ))}
            </div>
            <div className="border-t border-border pt-3">
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={busy || round.status !== "running"}
              >
                {submitting ? "Submitting…" : "Save & submit for scoring"}
              </button>
              <p className="mt-2 text-xs text-muted">
                {round.status === "running"
                  ? "Runs your code on the whole round and records the score. Your latest submission counts."
                  : round.status === "finished"
                    ? "Closed: scores are final."
                    : "Submissions aren't open yet. You can still backtest."}
              </p>
              {scored && (
                <p className="mt-2 text-sm text-bid">
                  Score <span className="num">{formatScore(scored.score)}</span>, rank #{scored.rank}.
                </p>
              )}
            </div>
          </section>
        )}

        <section className="panel space-y-3 p-4">
          <h2 className="font-semibold">{round ? "Backtest on the round's data" : "Backtest on local data"}</h2>
          {!round && datasets.length === 0 ? (
            <p className="text-sm text-muted">No published datasets yet. An admin publishes one per lobby.</p>
          ) : (
            <>
              <div className={`grid gap-2 ${round ? "grid-cols-[110px]" : "grid-cols-[1fr_110px]"}`}>
                {!round && (
                  <select className="input" value={lobbyId} onChange={(e) => setLobbyId(e.target.value)}>
                    {datasets.map((d) => (
                      <option key={d.lobbyId} value={d.lobbyId}>
                        {d.name} ({d.ticks.toLocaleString()} ticks)
                      </option>
                    ))}
                  </select>
                )}
                <input
                  className="input num"
                  placeholder="all ticks"
                  inputMode="numeric"
                  aria-label="Ticks to run"
                  value={maxTicks}
                  onChange={(e) => setMaxTicks(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              {!round && <PriceChart path={pricePaths[lobbyId]} />}
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={backtest} disabled={busy}>
                  {running && !submitting ? "Running…" : "Run backtest"}
                </button>
                {running && (
                  <button className="btn" onClick={() => worker.current?.terminate()}>
                    Stop
                  </button>
                )}
                {!round &&
                  LIVE_FILES.map((file) => (
                    <button key={file} className="btn" onClick={() => download(file)} disabled={!lobbyId}>
                      {file}
                    </button>
                  ))}
              </div>
              {status && <p className="text-xs text-muted">{status}</p>}
              {running && dataTicks && (
                <div className="h-1.5 overflow-hidden rounded bg-panel-2">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width: `${Math.min(100, (100 * progress) / Math.min(dataTicks, Number(maxTicks) || dataTicks))}%`,
                    }}
                  />
                </div>
              )}
              <p className="text-xs text-muted">
                {round
                  ? "Uses the same engine that scores the round."
                  : "Replays the lobby's published ticks with the live matching engine. Live trading continues where this data ends."}
              </p>
            </>
          )}
        </section>

        {result && stats && (
          <section className="panel space-y-3 p-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              {round ? (
                <Stat label="Score" value={formatScore(result.score)} tone={result.score >= 0 ? "text-bid" : "text-ask"} />
              ) : (
                <Stat label="Result" value={stats.pnl.toFixed(0)} tone={stats.pnl >= 0 ? "text-bid" : "text-ask"} />
              )}
              <Stat label="Biggest dip" value={stats.drawdown.toFixed(0)} />
              <Stat label="Trades" value={String(result.fills.length)} />
              <Stat label="Refused" value={String(result.rejects)} tone={result.rejects ? "text-accent" : ""} />
              <Stat label="Errors" value={String(result.errors.length)} tone={result.errors.length ? "text-ask" : ""} />
              <Stat label="Units owned" value={String(stats.position[0] ?? 0)} />
            </div>
            <LineChart points={stats.pnlPoints} />
            <p className="text-xs text-muted">
              {round
                ? round.preset === "BEST_TIME"
                  ? "Score = money + units owned × the final price."
                  : "The chart counts units you own at the current price; the score uses the average."
                : "The chart counts units you own at the current price; the live round's final score uses their true value."}
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

/** The published prices of the selected live dataset. */
function PriceChart({ path }: { path: [number, number][] | string | undefined }) {
  if (typeof path === "string") return <p className="text-xs text-muted">{path}</p>;
  if (!path) return <div className="h-[150px] animate-pulse rounded bg-panel-2" />;
  return (
    <div>
      <LineChart points={path} color="#f0b429" height={150} />
      <p className="mt-1 text-xs text-muted">
        The price at each of the {path.length.toLocaleString()} published ticks. The live round carries on from the
        last one.
      </p>
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

function writeDraft(key: string, draft: Draft) {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {}
}

const formatScore = (score: number) => (Number.isInteger(score) ? score : score.toFixed(2)).toLocaleString();

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
