// Engine public market feed (engine/server/feed.py). One WebSocket per lobby, no auth.

export type Level = [price: number, qty: number];
export type Book = { bids: Level[]; asks: Level[] };
export type Trade = [price: number, qty: number, aggressor: 1 | -1];
export type LeaderRow = { group_id: string; name: string; pnl: number };

export type SnapshotMessage = {
  type: "snapshot";
  status: string;
  tick: number | null;
  tick_ms: number;
  goods: string[];
  history: Record<string, [tick: number, mid: number][]>;
  books: Record<string, Book>;
  leaderboard: LeaderRow[];
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

export type FeedMessage = SnapshotMessage | TickMessage | StatusMessage;

export function wsUrl(engineUrl: string, path: string) {
  return engineUrl.replace(/^http/, "ws") + path;
}

/** Reconnecting WebSocket with exponential backoff (Render deploys drop connections). */
export function connectFeed(
  url: string,
  onMessage: (msg: FeedMessage) => void,
  onState: (connected: boolean) => void,
  onOpen?: (ws: WebSocket) => void,
) {
  let ws: WebSocket | null = null;
  let delay = 500;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 500;
      onState(true);
      onOpen?.(ws!);
    };
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
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
      ws?.close();
    },
  };
}
