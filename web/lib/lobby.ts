import type { Json } from "@/lib/supabase/database.types";

/** Preset names understood by the engine (engine/market_core/config.py). */
export const GOOD_PRESETS: Record<string, string> = {
  STABLE: "Calm: the price keeps drifting back to the same level",
  VOLATILE: "Jumpy: the price wanders, with calm and wild spells and sudden jumps",
};

/** Static rounds: markets generated once and published in full (engine/market_core/static_rounds.py). */
export const STATIC_PRESETS = {
  BEST_TIME: {
    name: "Best time to buy and sell",
    good: "STOCK",
    ticks: 500,
    files: ["prices.csv"],
    description: "One price per tick. Own at most one unit, and buy and sell it as often as you like.",
  },
  FLAT_MEAN: {
    name: "Steady average",
    good: "FLAT",
    ticks: 2000,
    files: ["prices.csv", "trades.csv"],
    description: "The price stays near one average. Buy a bit below it and sell a bit above it.",
  },
} as const;

export type StaticPreset = keyof typeof STATIC_PRESETS;

export const isStaticPreset = (value: unknown): value is StaticPreset =>
  typeof value === "string" && value in STATIC_PRESETS;

/** What participants may see about a lobby. The engine fills in rules when it prepares one. */
export type PublicConfig = {
  goods: string[];
  tick_ms: number;
  dataset_ticks: number;
  live_ticks: number;
  rules?: {
    position_limits: Record<string, number>;
    max_orders_per_tick?: number;
    max_open_orders?: number;
    maker_fee?: number;
    taker_fee?: number;
    min_positions?: Record<string, number>;
  };
  /** Static rounds only. */
  preset?: StaticPreset;
  /** Static rounds only: a downsampled price path per good for charts. */
  preview?: Record<string, [tick: number, price: number][]>;
};

export function publicConfig(json: Json): PublicConfig {
  const c = (json ?? {}) as Partial<PublicConfig>;
  return {
    goods: c.goods ?? [],
    tick_ms: c.tick_ms ?? 1000,
    dataset_ticks: c.dataset_ticks ?? 0,
    live_ticks: c.live_ticks ?? 0,
    rules: c.rules,
    preset: isStaticPreset(c.preset) ? c.preset : undefined,
    preview: c.preview,
  };
}

/** How a lobby's status reads to participants. Static rounds reuse the statuses with other meanings. */
export function statusLabel(kind: string, status: string): string {
  if (kind !== "static") return status;
  return (
    { scheduled: "published", running: "open", paused: "submissions paused", finished: "closed" }[
      status
    ] ?? status
  );
}

export const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted/15 text-muted",
  scheduled: "bg-sky-500/15 text-sky-400",
  running: "bg-bid/15 text-bid",
  paused: "bg-accent/15 text-accent",
  finished: "bg-foreground/10 text-foreground",
};
