import Link from "next/link";
import { LineChart } from "@/components/code/line-chart";
import type { StaticRound } from "@/lib/group";
import { STATIC_PRESETS, STATUS_STYLES, statusLabel } from "@/lib/lobby";

/** A published static round: what it is, its whole price path and its leaderboard. */
export function StaticRoundCard({
  round,
  leaders,
  codeHref,
}: {
  round: StaticRound;
  leaders: { name: string; score: number; rank: number }[];
  codeHref: string | null;
}) {
  const preset = STATIC_PRESETS[round.preset];
  const [good, points] = Object.entries(round.config.preview ?? {})[0] ?? [preset.good, []];
  return (
    <article className="panel flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{round.name}</h3>
          <p className="text-xs text-muted">
            {preset.name} · {good} · {round.config.dataset_ticks.toLocaleString()} ticks
          </p>
        </div>
        <span className={`badge ${STATUS_STYLES[round.status]}`}>{statusLabel("static", round.status)}</span>
      </header>
      <p className="text-sm text-foreground/80">{preset.description}</p>
      {points.length > 0 && <LineChart points={points} color="#f0b429" height={160} />}
      <div>
        <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted">Leaderboard</h4>
        {leaders.length === 0 && <p className="text-sm text-muted">No scores yet.</p>}
        <ol className="space-y-1">
          {leaders.slice(0, 5).map((row) => (
            <li key={row.name} className="flex justify-between text-sm">
              <span>
                <span className="num mr-2 text-muted">{row.rank}</span>
                {row.name}
              </span>
              <span className={`num ${row.score >= 0 ? "text-bid" : "text-ask"}`}>
                {Math.round(row.score).toLocaleString()}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {codeHref && (
        <Link href={codeHref} className="btn mt-auto self-start">
          Write code for this round
        </Link>
      )}
    </article>
  );
}
