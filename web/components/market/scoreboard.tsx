"use client";

import type { LeaderRow } from "@/lib/feed";
import { statusLabel } from "@/lib/lobby";

export type ScoreCell = { score: number; rank: number };

/** One static round's column: group id -> latest score and rank. */
export type ScoreColumn = { id: string; name: string; status: string; scores: Record<string, ScoreCell> };

export type ScoreboardData = { groups: { id: string; name: string }[]; columns: ScoreColumn[] };

/** Every group's score in each round: the live round (from the market feed) and each static round. */
export function Scoreboard({
  groups,
  columns,
  live,
}: ScoreboardData & { live?: { name: string; status: string | null; leaders: LeaderRow[] } }) {
  const liveCells = new Map<string, ScoreCell>(
    (live?.leaders ?? []).map((row, i) => [row.group_id, { score: row.pnl, rank: i + 1 }]),
  );
  const rows = [...groups].sort((a, b) => {
    const la = liveCells.get(a.id)?.rank ?? Infinity;
    const lb = liveCells.get(b.id)?.rank ?? Infinity;
    return la - lb || a.name.localeCompare(b.name);
  });
  if (rows.length === 0 || (!live && columns.length === 0)) return null;

  return (
    <section className="panel overflow-x-auto p-3">
      <h3 className="mb-1 font-semibold">Scoreboard</h3>
      <p className="mb-3 text-xs text-muted">
        Live scores update as the round runs. Static rounds show each group&apos;s latest submission.
      </p>
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="py-1 pr-3 font-medium">Group</th>
            {live && (
              <th className="py-1 pr-3 text-right font-medium">
                {live.name}
                <span className="block normal-case tracking-normal">live · {live.status ?? "…"}</span>
              </th>
            )}
            {columns.map((c) => (
              <th key={c.id} className="py-1 pr-3 text-right font-medium">
                {c.name}
                <span className="block normal-case tracking-normal">static · {statusLabel("static", c.status)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((g) => (
            <tr key={g.id}>
              <td className="py-1.5 pr-3">{g.name}</td>
              {live && <Cell cell={liveCells.get(g.id)} />}
              {columns.map((c) => (
                <Cell key={c.id} cell={c.scores[g.id]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Cell({ cell }: { cell: ScoreCell | undefined }) {
  if (!cell) return <td className="num py-1.5 pr-3 text-right text-muted">—</td>;
  return (
    <td className="num py-1.5 pr-3 text-right">
      <span className={cell.score >= 0 ? "text-bid" : "text-ask"}>{Math.round(cell.score).toLocaleString()}</span>
      <span className="ml-1.5 text-xs text-muted">#{cell.rank}</span>
    </td>
  );
}
