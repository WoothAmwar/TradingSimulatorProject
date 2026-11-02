/** A labelled point on a MiniChart. `tone` picks the colour. */
export type ChartMarker = { index: number; label: string; tone: "bid" | "ask" | "accent" };

const TONES = { bid: "fill-bid stroke-bid", ask: "fill-ask stroke-ask", accent: "fill-accent stroke-accent" };

const W = 600;
const H = 180;
const PAD = 14;
const TOP = 26; // room for marker labels above the highest point

/** A small SVG line chart over equally spaced points, with optional markers and a cursor. */
export function MiniChart({
  values,
  markers = [],
  cursor,
  dots = false,
  label,
}: {
  values: number[];
  markers?: ChartMarker[];
  cursor?: number;
  dots?: boolean;
  label: string;
}) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, values.length - 1);
  const y = (v: number) => H - PAD - ((v - lo) * (H - PAD - TOP)) / Math.max(1e-9, hi - lo);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
      {cursor !== undefined && cursor >= 0 && (
        <line x1={x(cursor)} x2={x(cursor)} y1={4} y2={H - 4} className="stroke-muted/40" strokeDasharray="4 4" />
      )}
      <polyline
        points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
        className="fill-none stroke-foreground/70"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {dots &&
        values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={3.5} className="fill-panel stroke-foreground/70" />)}
      {markers.map((m) => (
        <g key={`${m.label}-${m.index}`} className={TONES[m.tone]}>
          <circle cx={x(m.index)} cy={y(values[m.index])} r={6} strokeWidth={2} fillOpacity={0.25} />
          <text x={x(m.index)} y={y(values[m.index]) - 11} textAnchor="middle" className="stroke-none text-[13px]">
            {m.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
