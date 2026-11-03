import { KEEPALIVE, KEEPALIVE_MS, wsUrl } from "@/lib/feed";

// A group's bot runs on the engine (engine/server/bots.py); this socket only watches it.

export type BotStatus = "waiting" | "none" | "starting" | "running" | "stopped";
export type BotInfo = {
  status: BotStatus;
  message: string | null;
  submission: { id: string; title: string; language: string } | null;
};
export type BotStats = { answered: number; missed: number; rejects: number; avg_ms: number };
export type BotFill = { tick: number; good: string; price: number; qty: number };
export type ConsoleEntry = { kind: "log" | "info" | "error"; text: string };
type Account = { position: Record<string, number>; cash: number; pnl: number };

export type MonitorMessage =
  | ({
      type: "snapshot";
      status: string;
      tick: number | null;
      end_tick: number;
      bot: BotInfo;
      stats: BotStats;
      fills: BotFill[];
      console: ConsoleEntry[];
    } & Account)
  | { type: "bot"; bot: BotInfo }
  | ({ type: "result"; tick: number; fills: Omit<BotFill, "tick">[]; rejects: string[]; stats: BotStats } & Account)
  | { type: "console"; lines: ConsoleEntry[] }
  | { type: "status"; status: string; tick: number | null };

// Close codes after which reconnecting would not help.
const FINAL_CODES = new Set([1000, 4401, 4403, 4404]);

/** Watches a group's bot in a lobby, reconnecting with backoff until closed. */
export function watchBot(opts: {
  engineUrl: string;
  lobbyId: string;
  groupId: string;
  getToken: () => Promise<string | null>;
  onMessage: (msg: MonitorMessage) => void;
  onState: (connected: boolean) => void;
  onClosed: (reason: string) => void;
}) {
  let ws: WebSocket | null = null;
  let delay = 500;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const keepalive = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(KEEPALIVE);
  }, KEEPALIVE_MS);

  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(keepalive);
  };

  const open = () => {
    const s = new WebSocket(wsUrl(opts.engineUrl, `/ws/bot/${opts.lobbyId}`));
    ws = s;
    s.onopen = async () => {
      delay = 500;
      opts.onState(true);
      const token = (await opts.getToken()) ?? "";
      s.send(JSON.stringify({ type: "auth", token, group_id: opts.groupId }));
    };
    s.onmessage = (ev) => opts.onMessage(JSON.parse(ev.data));
    s.onclose = (ev) => {
      opts.onState(false);
      if (closed) return;
      if (FINAL_CODES.has(ev.code)) {
        stop();
        opts.onClosed(ev.reason || `connection closed (${ev.code})`);
        return;
      }
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();

  return {
    close: () => {
      stop();
      ws?.close();
    },
  };
}
