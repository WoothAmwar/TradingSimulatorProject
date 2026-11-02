import { MiniChart } from "./mini-chart";
import { mulberry32, normal } from "./random";

const TICKS = 300;

function stablePath() {
  const rand = mulberry32(7);
  const out = [];
  let x = 100;
  for (let t = 0; t < TICKS; t++) {
    out.push(x);
    x += 0.05 * (100 - x) + 0.8 * normal(rand); // pulled back towards 100
  }
  return out;
}

function volatilePath() {
  const rand = mulberry32(11);
  const out = [];
  let x = 100;
  let vol = 0.006;
  let shock = 0;
  for (let t = 0; t < TICKS; t++) {
    out.push(x);
    vol = Math.sqrt(2e-6 + 0.1 * shock ** 2 + 0.88 * vol ** 2); // calm and stormy spells
    shock = vol * normal(rand);
    const jump = rand() < 0.01 ? 0.05 * normal(rand) : 0; // rare jumps
    x *= Math.exp(shock + jump);
  }
  return out;
}

/** Illustrative paths for the two kinds of goods. */
export function PricePaths() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <figure className="panel p-3">
        <MiniChart values={stablePath()} label="A calm price that keeps returning to one level" />
        <figcaption className="mt-2 text-sm">
          <strong>STABLE</strong> is calm: it keeps drifting back to one level, so an average of past prices is a
          good guess of its worth.
        </figcaption>
      </figure>
      <figure className="panel p-3">
        <MiniChart values={volatilePath()} label="A jumpy price that wanders" />
        <figcaption className="mt-2 text-sm">
          <strong>VOLATILE</strong> is jumpy: it wanders and sometimes leaps, so trust recent prices more and
          trade smaller amounts.
        </figcaption>
      </figure>
    </div>
  );
}
