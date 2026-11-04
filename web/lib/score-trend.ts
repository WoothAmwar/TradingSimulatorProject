// Recent leaderboard scores per group, for the live board's "last 300 ticks" and "per tick"
// columns. The engine sends scores every 5 ticks; lobby_score_history fills in earlier ones
// (saved every 10 ticks) when a page opens mid-round.

export const RECENT_TICKS = 300;
export const RATE_TICKS = 1_000; // longer than RECENT_TICKS: held units make short spans noisy
const MIN_RATE_TICKS = 50; // fewer ticks give wild rates
const MAX_GAP = 20; // a point further than this before the tick asked for is too stale to use
/** How far back scores are kept, and loaded when a page opens mid-round. */
export const HISTORY_TICKS = RATE_TICKS + MAX_GAP;

export type ScorePoint = [tick: number, pnl: number];
export type ScoreHistory = Record<string, ScorePoint[]>;
export type SavedScores = { group_id: string; ticks: number[]; pnls: number[] }[];
export type Trend = { recent: number | null; perTick: number | null };

/** Adds the leaderboard at `tick` and drops points older than the longest window needs. */
export function addScores(
  history: ScoreHistory,
  tick: number,
  rows: { group_id: string; pnl: number }[],
): ScoreHistory {
  const keepFrom = tick - HISTORY_TICKS;
  const next: ScoreHistory = {};
  for (const row of rows) {
    const points = (history[row.group_id] ?? []).filter(([t]) => t >= keepFrom && t < tick);
    next[row.group_id] = [...points, [tick, row.pnl]];
  }
  return next;
}

/** Merges scores saved by the engine; points from the feed win on the same tick. */
export function mergeSaved(history: ScoreHistory, saved: SavedScores): ScoreHistory {
  const next = { ...history };
  for (const { group_id, ticks, pnls } of saved) {
    const byTick = new Map<number, number>(ticks.map((t, i) => [t, pnls[i]]));
    for (const [t, pnl] of history[group_id] ?? []) byTick.set(t, pnl);
    next[group_id] = [...byTick].sort((a, b) => a[0] - b[0]);
  }
  return next;
}

/** A group's score at `tick`: 0 before the round starts, null if no recent enough point. */
function scoreAt(points: ScorePoint[], tick: number, startTick: number): number | null {
  if (tick <= startTick) return 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const [t, pnl] = points[i];
    if (t <= tick) return tick - t <= MAX_GAP ? pnl : null;
  }
  return null;
}

/**
 * Change in score over the last RECENT_TICKS, and average change per tick over the last
 * RATE_TICKS (or since the round started, if sooner). `startTick` is the first live tick.
 */
export function trend(points: ScorePoint[] | undefined, startTick: number): Trend {
  const last = points?.[points.length - 1];
  if (!points || !last) return { recent: null, perTick: null };
  const [tick, pnl] = last;
  const recentFrom = scoreAt(points, tick - RECENT_TICKS, startTick);
  const span = Math.min(RATE_TICKS, tick - startTick);
  const rateFrom = span >= MIN_RATE_TICKS ? scoreAt(points, tick - span, startTick) : null;
  return {
    recent: recentFrom === null ? null : pnl - recentFrom,
    perTick: rateFrom === null ? null : (pnl - rateFrom) / span,
  };
}

/** How long `ticks` lasts, e.g. "60 s" for 300 ticks of 200 ms. */
export function tickSeconds(ticks: number, tickMs: number): string {
  return `${((ticks * tickMs) / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
}
