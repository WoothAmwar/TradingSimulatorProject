// Participant code runs in workers created inside a sandboxed iframe (allow-scripts only, so it
// has an opaque origin): it cannot read this page, its cookies, or call our APIs as the user.
// The iframe relays messages between the page and its workers. Chrome refuses blob: module
// workers in an opaque origin, but allows data: module workers (which keep the opaque origin).

const BOOT = `<!doctype html><meta charset="utf-8"><script>
const workers = new Map();
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "spawn") {
    const url = "data:text/javascript;charset=utf-8," + encodeURIComponent(m.code);
    const worker = new Worker(url, { type: "module" });
    worker.onmessage = (ev) => {
      const r = ev.data && ev.data.result;
      parent.postMessage({ type: "message", wid: m.wid, data: ev.data }, "*", r instanceof Uint8Array ? [r.buffer] : []);
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      parent.postMessage({ type: "crash", wid: m.wid, message: ev.message || "worker failed to start" }, "*");
    };
    workers.set(m.wid, worker);
  } else if (m.type === "post") {
    const w = workers.get(m.wid);
    if (w) w.postMessage(m.data, m.transfer || []);
  } else if (m.type === "kill") {
    const w = workers.get(m.wid);
    if (w) w.terminate();
    workers.delete(m.wid);
  }
});
parent.postMessage({ type: "ready" }, "*");
</script>`;

type WorkerReply = {
  id: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
  progress?: unknown;
};

type Pending = {
  resolve: (reply: { result: unknown; logs: string[] }) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: unknown, logs: string[]) => void;
};

export class WorkerCrashed extends Error {}

export class RuntimeWorker {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;

  constructor(
    private sandbox: Sandbox,
    readonly wid: number,
  ) {}

  call<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    opts: { transfer?: Transferable[]; onProgress?: Pending["onProgress"] } = {},
  ): Promise<{ result: T; logs: string[] }> {
    if (this.dead) return Promise.reject(new WorkerCrashed("worker was stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as Pending["resolve"],
        reject,
        onProgress: opts.onProgress,
      });
      this.sandbox.post(this.wid, { id, cmd, args }, opts.transfer ?? []);
    });
  }

  /** @internal */
  receive(reply: WorkerReply) {
    const p = this.pending.get(reply.id);
    if (!p) return;
    if (reply.progress !== undefined) {
      p.onProgress?.(reply.progress, reply.logs ?? []);
      return;
    }
    this.pending.delete(reply.id);
    if (reply.ok) p.resolve({ result: reply.result, logs: reply.logs ?? [] });
    else p.reject(Object.assign(new Error(reply.error ?? "unknown error"), { logs: reply.logs ?? [] }));
  }

  /** @internal */
  crash(message: string) {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(new WorkerCrashed(message));
    this.pending.clear();
  }

  terminate() {
    if (this.dead) return;
    this.sandbox.kill(this.wid);
    this.crash("worker was stopped");
  }
}

export class Sandbox {
  private workers = new Map<number, RuntimeWorker>();
  private nextWid = 1;

  private constructor(private frame: HTMLIFrameElement) {
    window.addEventListener("message", (e) => {
      if (e.source !== frame.contentWindow) return;
      const msg = e.data as { type: string; wid: number; data?: WorkerReply; message?: string };
      const worker = this.workers.get(msg.wid);
      if (!worker) return;
      if (msg.type === "message" && msg.data) worker.receive(msg.data);
      if (msg.type === "crash") {
        worker.crash(msg.message ?? "worker crashed");
        this.workers.delete(msg.wid);
      }
    });
  }

  static create(): Promise<Sandbox> {
    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.style.display = "none";
      frame.srcdoc = BOOT;
      const onReady = (e: MessageEvent) => {
        if (e.source === frame.contentWindow && e.data?.type === "ready") {
          window.removeEventListener("message", onReady);
          resolve(new Sandbox(frame));
        }
      };
      window.addEventListener("message", onReady);
      document.body.appendChild(frame);
    });
  }

  spawn(code: string): RuntimeWorker {
    const worker = new RuntimeWorker(this, this.nextWid++);
    this.workers.set(worker.wid, worker);
    this.frame.contentWindow!.postMessage({ type: "spawn", wid: worker.wid, code }, "*");
    return worker;
  }

  /** @internal */
  post(wid: number, data: unknown, transfer: Transferable[]) {
    this.frame.contentWindow!.postMessage({ type: "post", wid, data, transfer }, "*", transfer);
  }

  /** @internal */
  kill(wid: number) {
    this.workers.delete(wid);
    this.frame.contentWindow!.postMessage({ type: "kill", wid }, "*");
  }
}

let sandbox: Promise<Sandbox> | null = null;
const scripts = new Map<string, Promise<string>>();

export function getSandbox(): Promise<Sandbox> {
  sandbox ??= Sandbox.create();
  return sandbox;
}

/** Worker sources are fetched by the page (same origin) and handed to the sandbox as text. */
export function workerScript(path: string): Promise<string> {
  if (!scripts.has(path)) {
    scripts.set(
      path,
      fetch(path).then((r) => {
        if (!r.ok) throw new Error(`could not load ${path}`);
        return r.text();
      }),
    );
  }
  return scripts.get(path)!;
}
