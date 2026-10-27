import type { Json } from "@/lib/supabase/database.types";

/** Preset names understood by the engine (engine/market_core/config.py). */
export const GOOD_PRESETS: Record<string, string> = {
  STABLE: "Mean-reverting around a hidden fair value (Ornstein–Uhlenbeck)",
  VOLATILE: "Fat-tailed returns with volatility clustering and jumps (GBM + GARCH + jumps)",
};

/** What participants may see about a lobby. The engine fills in rules when it prepares one. */
export type PublicConfig = {
  goods: string[];
  tick_ms: number;
  dataset_ticks: number;
  live_ticks: number;
  rules?: {
    position_limits: Record<string, number>;
    max_orders_per_tick: number;
    max_open_orders: number;
    maker_fee: number;
    taker_fee: number;
  };
};

export function publicConfig(json: Json): PublicConfig {
  const c = (json ?? {}) as Partial<PublicConfig>;
  return {
    goods: c.goods ?? [],
    tick_ms: c.tick_ms ?? 1000,
    dataset_ticks: c.dataset_ticks ?? 0,
    live_ticks: c.live_ticks ?? 0,
    rules: c.rules,
  };
}

export const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted/15 text-muted",
  scheduled: "bg-sky-500/15 text-sky-400",
  running: "bg-bid/15 text-bid",
  paused: "bg-accent/15 text-accent",
  finished: "bg-foreground/10 text-foreground",
};
