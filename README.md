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

**Engine (Render).**
- Create the service from `render.yaml`, either through the Render Blueprint flow or the Render MCP.
- Set `SUPABASE_SECRET_KEY` and `ALLOWED_ORIGINS` (your Vercel URL) when prompted.
- Use the paid `0.5c-512mb` plan, which stays always-on. Auto-deploy is off; deploy deliberately,
  never during a live lobby.

**Web (Vercel).**
- Import the repo with root directory `web`.
- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `NEXT_PUBLIC_ENGINE_URL` (the Render URL).

## Running an event

1. Admin (home page) creates groups and shares each group's invite link.
2. Admin creates a lobby: goods, tick length, K, duration, N groups, optional seed.
3. Admin enters groups and clicks **Build dataset & publish**. Groups can now backtest.
4. Groups save submissions and pick one active submission per lobby. One member opens **Live
   trading** and starts the bot. It runs in that tab.
5. Admin clicks **Start live trading**. The lobby ends by itself after its live ticks, or when **End
   lobby** is clicked. Final results are stored and shown on the home page.
