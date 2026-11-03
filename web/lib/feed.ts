// Engine public market feed (engine/server/feed.py). One WebSocket per lobby, no auth.

export type Level = [price: number, qty: number];
export type Book = { bids: Level[]; asks: Level[] };
export type Trade = [price: number, qty: number, aggressor: 1 | -1];
// `online`: the group's bot is connected (sent while the lobby runs, not in final results).
export type LeaderRow = { group_id: string; name: string; pnl: number; online?: boolean };

/** One side of a group trade: the group, or null for the computer traders. */
export type TradeParty = { id: string; name: string } | null;

/** A fill a group took part in (engine/server/trades.py). */
export type GroupTrade = {
  tick: number;
  good: string;
  price: number;
  qty: number;
  aggressor: 1 | -1; // the side that took the price
  mid: number | null; // the market price when the tick opened
  buyer: TradeParty;
  seller: TradeParty;
};

/** A group's totals for the round. `edge`: how much better than the market price, times units. */
export type GroupStats = {
  name: string;
  trades: number;
  bought: number;
  sold: number;
  spent: number;
  received: number;
  edge: number;
  with_groups: number;
  took: number;
};

export type SnapshotMessage = {
  type: "snapshot";
  status: string;
  tick: number | null;
  tick_ms: number;
  goods: string[];
  history: Record<string, [tick: number, mid: number][]>;
  books: Record<string, Book>;
  leaderboard: LeaderRow[];
  group_trades?: GroupTrade[]; // the most recent ones
  group_stats?: Record<string, GroupStats>; // group id -> totals
};

export type TickMessage = {
  type: "tick";
  tick: number;
  books: Record<string, Book>;
  trades: Record<string, Trade[]>;
  mids: Record<string, number | null>;
  leaderboard?: LeaderRow[];
};

export type StatusMessage = { type: "status"; status: string; tick: number | null };

/** Sent when a tick closes with group trades in it. */
export type TradesMessage = { type: "trades"; tick: number; trades: GroupTrade[] };

export type FeedMessage = SnapshotMessage | TickMessage | StatusMessage | TradesMessage;

export function wsUrl(engineUrl: string, path: string) {
  return engineUrl.replace(/^http/, "ws") + path;
}

// Render's free plan spins the engine down after 15 minutes without inbound traffic (WebSocket
// messages count). Open pages send this message, which the engine ignores, more often than that.
export const KEEPALIVE_MS = 4 * 60_000;
export const KEEPALIVE = JSON.stringify({ type: "ping" });
const ACTIVE = new Set(["scheduled", "running", "paused"]);

/**
 * Reconnecting WebSocket with exponential backoff (engine restarts and spin-ups drop
 * connections). Keeps the engine awake while the lobby is scheduled, running or paused.
 */
export function connectFeed(
  url: string,
  onMessage: (msg: FeedMessage) => void,
  onState: (connected: boolean) => void,
  onOpen?: (ws: WebSocket) => void,
) {
  let ws: WebSocket | null = null;
  let delay = 500;
  let closed = false;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keepalive = setInterval(() => {
    if (active && ws?.readyState === WebSocket.OPEN) ws.send(KEEPALIVE);
  }, KEEPALIVE_MS);

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 500;
      onState(true);
      onOpen?.(ws!);
    };
    ws.onmessage = (ev) => {
      const msg: FeedMessage = JSON.parse(ev.data);
      if (msg.type === "snapshot" || msg.type === "status") active = ACTIVE.has(msg.status);
      onMessage(msg);
    };
    ws.onclose = () => {
      onState(false);
      if (!closed) timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();

  return {
    send: (data: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)),
    close: () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(keepalive);
      ws?.close();
    },
  };
}
