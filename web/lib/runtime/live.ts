import { KEEPALIVE, KEEPALIVE_MS, wsUrl } from "@/lib/feed";
import type { RuntimeWorker } from "./sandbox";

export type LiveEvent =
  | { type: "connected" | "disconnected" }
  | { type: "welcome"; tick: number | null; status: string; endTick: number }
  | { type: "tick"; tick: number; ms: number }
  | { type: "missed"; tick: number; reason: string }
  | {
      type: "result";
      tick: number;
      pnl: number;
      cash: number;
      position: Record<string, number>;
      fills: { good: string; price: number; qty: number }[];
      rejects: string[];
    }
  | { type: "logs"; lines: string[] }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

// Close codes after which reconnecting would not help.
const FINAL_CODES = new Set([1000, 4001, 4401, 4403, 4404]);
const HANG_MS = 15_000;

/**
 * Connects a bot worker to the engine's trading socket: every tick the engine sends this group's
 * state, the bot answers before the deadline, and the engine sends back fills and rejects.
 */
export class LiveSession {
  private busySince: number | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  // Bots already send orders every tick; this covers paused lobbies (see KEEPALIVE_MS).
  private keepalive = setInterval(() => {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(KEEPALIVE);
  }, KEEPALIVE_MS);

  constructor(
    private opts: {
      engineUrl: string;
      lobbyId: string;
      worker: RuntimeWorker;
      getToken: () => Promise<string | null>;
      restart: () => Promise<RuntimeWorker>;
      onEvent: (event: LiveEvent) => void;
    },
  ) {}

  start() {
    const { engineUrl, lobbyId, onEvent } = this.opts;
    const url = wsUrl(engineUrl, `/ws/trade/${lobbyId}`);
    const connect = () => {
      const s = new WebSocket(url);
      this.ws = s;
      s.onopen = async () => {
        onEvent({ type: "connected" });
        s.send(JSON.stringify({ type: "auth", token: (await this.opts.getToken()) ?? "" }));
      };
      s.onmessage = (ev) => this.handle(s, JSON.parse(ev.data));
      s.onclose = (ev) => {
        onEvent({ type: "disconnected" });
        if (this.stopped) return;
        if (FINAL_CODES.has(ev.code)) {
          this.stopped = true;
          clearInterval(this.keepalive);
          onEvent({ type: "closed", reason: ev.reason || `connection closed (${ev.code})` });
          return;
        }
        setTimeout(() => !this.stopped && connect(), 1500);
      };
    };
    connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keepalive);
    this.ws?.close(1000);
  }

  private async handle(ws: WebSocket, msg: Record<string, unknown>) {
    const { onEvent } = this.opts;
    switch (msg.type) {
      case "welcome":
        onEvent({
          type: "welcome",
          tick: msg.tick as number | null,
          status: msg.status as string,
          endTick: msg.end_tick as number,
        });
        return;
      case "state":
        await this.onState(ws, msg.tick as number, msg.deadline_ms as number, msg.state);
        return;
      case "result":
        onEvent({
          type: "result",
          tick: msg.tick as number,
          pnl: msg.pnl as number,
          cash: msg.cash as number,
          position: msg.position as Record<string, number>,
          fills: msg.fills as { good: string; price: number; qty: number }[],
          rejects: msg.rejects as string[],
        });
        return;
      case "late":
        onEvent({ type: "missed", tick: msg.tick as number, reason: "response arrived after the deadline" });
        return;
    }
  }

  private async onState(ws: WebSocket, tick: number, deadlineMs: number, state: unknown) {
    const { onEvent } = this.opts;
    if (this.busySince !== null) {
      onEvent({ type: "missed", tick, reason: "bot is still working on an earlier tick" });
      if (Date.now() - this.busySince > HANG_MS) await this.restartWorker();
      return;
    }
    const started = performance.now();
    this.busySince = Date.now();
    const call = this.opts.worker.call<string>("tick", { state: JSON.stringify(state) });
    call.then(
      ({ logs }) => logs.length && onEvent({ type: "logs", lines: logs }),
      (e: Error & { logs?: string[] }) => {
        if (e.logs?.length) onEvent({ type: "logs", lines: e.logs });
        onEvent({ type: "error", message: `tick ${tick}: ${e.message}` });
      },
    ).finally(() => (this.busySince = null));

    const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(20, deadlineMs - 25)));
    const outcome = await Promise.race([call.catch(() => undefined), timeout]);
    if (outcome === null) {
      onEvent({ type: "missed", tick, reason: "bot took longer than the tick deadline" });
      return;
    }
    if (outcome === undefined) return; // the bot raised; reported above
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "orders", tick, response: JSON.parse(outcome.result) }));
    }
    onEvent({ type: "tick", tick, ms: Math.round(performance.now() - started) });
  }

  private async restartWorker() {
    this.opts.onEvent({ type: "error", message: "Bot appears stuck; restarting it (its state is lost)." });
    this.opts.worker.terminate();
    this.busySince = null;
    try {
      this.opts.worker = await this.opts.restart();
    } catch (e) {
      this.opts.onEvent({ type: "error", message: `Restart failed: ${(e as Error).message}` });
      this.stop();
    }
  }
}
