# ACM Trading Simulator

A live, seeded market for algorithmic-trading competitions, in the spirit of IMC Prosperity. Groups
write bots in Python, C or C++ (Java and Go can be written and saved, not yet run), backtest them in
the browser on a public slice of the market, then run them live against every other group as makers
and takers.

```
Browser (Next.js on Vercel) ── public market feed / trading socket ──▶ Engine (FastAPI on Render)
  bots run here, sandboxed                                               tick loop + matching
            └───────────── Supabase: Postgres (RLS) · Auth (Google, GitHub) · Storage ◀────┘
```

| Path | What |
| --- | --- |
| `engine/market_core/` | Seeded price models, bot order flow, order book and exchange (pure Python) |
| `engine/server/` | Lobby runner (tick loop), admin API, WebSockets, Supabase persistence |
| `web/` | Next.js 16 app: market view, admin panel, group workspaces, in-browser runtimes |
| `web/public/runtimes/` | Sandboxed workers: Pyodide bot host and engine, in-browser Clang, C/C++ SDK |
| `supabase/migrations/` | Schema, RLS policies and RPCs (applied with the Supabase MCP) |
| `render.yaml` | Render Blueprint for the engine |

## How the market works

- **Fair value** per good follows a hidden stochastic process. `STABLE` is Ornstein–Uhlenbeck mean
  reversion. `VOLATILE` is GBM with GARCH(1,1) volatility clustering, Student-t shocks and Merton jumps.
- **Bot order flow** (the market without participants) has three parts:
  - a market maker that quotes around a noisy fair-value estimate and widens with volatility;
  - zero-intelligence noise traders: Poisson arrivals, exponential price offsets, geometric sizes;
  - a Kyle-style informed trader that sees the fair value a few ticks ahead.
- Everything is a deterministic function of the lobby's **secret 128-bit seed**.
- **Ticks**:
  1. The maker refreshes its quotes and every bot sees the book.
  2. Groups respond before the deadline.
  3. Their batches are matched in a seeded random order (price-time priority).
  4. The bot takers arrive.

  Resting orders persist, so groups make markets for each other.
- **Local data** is ticks `0…K-1` of the lobby's market. The live lobby continues from tick `K`.
  Backtests replay those ticks through the same matching code as the live engine (copied by
  `npm run sync:engine`), so a backtest reproduces the live market exactly for a single group.
- **Scoring**: cash + positions marked at the hidden fair value when the lobby ends.

## Local development

Prerequisites: [uv](https://docs.astral.sh/uv/), Node 20+.

```bash
# Engine
cd engine
cp .env.example .env            # add the Supabase secret key
set -a; source .env; set +a
uv run uvicorn server.main:app --reload --port 8000

# Web (another terminal)
cd web
npm install
npm run dev                     # http://localhost:3000; .env.local points at Supabase + engine
```

A dataset can also be built without Supabase:
`cd engine && uv run python -m scripts.make_dataset --seed 42 --out out/demo`.

## Tests

```bash
cd engine && uv run pytest                      # market model, exchange, determinism, server, recovery
cd web && npx tsc --noEmit && npx eslint . && npx next build
cd web/runtime-tests && npm install && npm test # bot workers under Node + headless Chrome (needs network)
```

`supabase/tests/rls_smoke.sql` checks every RLS boundary. Run it with the Supabase MCP's
`execute_sql`; it always rolls back and reports results in its final error message.

## One-time setup (manual steps)

1. **OAuth providers.** Supabase Auth has no API for this here, so it's done by hand.
   - Create a Google OAuth client (Google Cloud Console → Credentials) and a GitHub OAuth App.
   - Use the callback URL `https://cjbtwjkotakbtxmnhqhq.supabase.co/auth/v1/callback` for both.
   - Paste each client ID and secret into Supabase → Authentication → Sign In / Providers.
   - Under URL Configuration, set the Site URL to your Vercel domain. Add redirect URLs for
     `http://localhost:3000/**` and `https://<your-vercel-domain>/**`.
   - Disable the Email provider so there are no passwords.
2. **Admins.** `admin_allowlist` is seeded with the organizer's email. Allowlisted emails become admins
   on first sign-in. Admins can promote others from the home page.
3. **Engine secret.** Copy a secret key from Supabase → Project Settings → API Keys into
   `SUPABASE_SECRET_KEY`: in `engine/.env` locally, and in Render as described below.

## Deploying

Everything runs on free plans: Render Free, Supabase Free and Vercel Hobby.

**Engine (Render, free plan).**
- Create the service from `render.yaml`, either through the Render Blueprint flow or the Render MCP:
  a Docker web service built from `engine/`, in Ohio, with `/health` as its health check.
- Set `SUPABASE_SECRET_KEY` yourself in the Render dashboard (never paste it into a chat or commit).
  Set `ALLOWED_ORIGINS` to your Vercel URL, plus `http://localhost:3000` if you develop against it.
- Auto-deploy is off. Deploy deliberately, never during a live lobby: a deploy drops every WebSocket.

**Web (Vercel Hobby).**
- Import the repo with root directory `web`.
- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `NEXT_PUBLIC_ENGINE_URL` (the Render URL).

## Free-plan limits and how the app handles them

**Render Free web service** (0.1 CPU, 512 MB, one instance)
- *Spin-down.* It sleeps after 15 minutes without inbound traffic. WebSocket messages from the
  browser count. Live bots send orders every tick, and open pages send a keep-alive every 4 minutes
  while a lobby is scheduled, running or paused. Waking takes about a minute; the admin panel
  wakes the engine when it loads.
- *Restarts.* Render may restart a free service at any time. The engine rebuilds every running or
  paused lobby by replaying its recorded orders from Supabase. The market freezes for a minute or
  two, then continues exactly where it was. Browsers reconnect on their own.
- *CPU.* Building a dataset or starting a lobby takes roughly 10–20 seconds on 0.1 CPU. Don't build
  datasets while another lobby is live.
- *Hours.* Each workspace gets 750 free instance hours a month, and sleeping doesn't count. One
  service running all month fits, as long as no other free services share the workspace.

**Supabase Free**
- *Database size.* At 500 MB of data the database goes read-only. Each lobby stores its ticks,
  orders and fills; deleting a lobby removes them.
- *Pausing.* Supabase pauses a project after a week of low activity. Open the project in the
  Supabase dashboard a few days before an event, and restore it there if it was paused.
- *Bandwidth.* 10 GB of bandwidth a month. A dataset download is about 2 MB.

**Vercel Hobby**
- Free for non-commercial use. Server functions may run up to 5 minutes, which leaves room for an
  admin action to wait while the engine wakes up.

## Running an event

0. A few days before, open the Supabase project so it isn't paused. Shortly before the event, open
   the home page as an admin to wake the engine.
1. Admin (home page) creates groups and shares each group's invite link.
2. Admin creates a lobby: goods, tick length, K, duration, N groups, optional seed.
3. Admin enters groups and clicks **Build dataset & publish**. Groups can now backtest.
4. Groups save submissions and pick one active submission per lobby. One member opens **Live
   trading** and starts the bot. It runs in that tab.
5. Admin clicks **Start live trading**. The lobby ends by itself after its live ticks, or when **End
   lobby** is clicked. Final results are stored and shown on the home page.
