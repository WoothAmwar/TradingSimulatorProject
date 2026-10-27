# Trading Simulator: a club market game modeled on IMC Prosperity

## Context
UChicago ACM wants a trading competition for a club event, modeled on IMC Prosperity. Up to N groups write trading bots in Python (the default), Java, C, C++, or Go. The bots trade simulated goods in one shared, live market and can act as makers (resting orders) or takers (orders that cross the spread). The market is generated from a seed using well-known stochastic models from market microstructure. Each team also gets a static local dataset: ticks `0…K−1` of the same seeded market. The live lobby picks up at tick `K`.

The repo has only `README.txt` (the original prompt), `.mcp.json` (Supabase MCP), and a `.gitignore`. Nothing is built yet.

**Decisions already made with you:**
- **Hosting.** The Next.js UI runs on Vercel. A small, always-on Python service (FastAPI) on **Render** runs the exchange. Vercel functions can't hold a single shared order book in memory.
- **Matching.** The market advances in discrete ticks. Within a tick, orders are processed in a random order derived from seed + tick, with price-time priority. Resting orders carry over to later ticks.
- **Local data.** The dataset is ticks `0…K−1` of the lobby's seed, and the live run continues from tick `K`. Knowing past ticks doesn't let anyone predict future ones, as long as the seed is a secret 128-bit value and the generator code never ships to the browser.
- **Accounts.** One live bot per group. Any member can mark one of the group's saved submissions as active and run it.
- **Joining.** Each group has an unguessable invite link. A user can belong to at most one group.
- **Goods.** Goods are configurable per lobby. It ships with two: STABLE, which mean-reverts, and VOLATILE (GBM + GARCH + jumps).
- **Visibility.** `/` is public and read-only. Sign-in is required for groups, code, and admin.
- **Admins.** A `profiles.is_admin` flag, seeded for your email. Admins can promote others.

## Architecture
```
Browser ─ Next.js 16 / React 19 on Vercel
  /                 public market view + admin panel (admins only)
  /g/[slug]/...     team workspace: editor, submissions, backtest, live
  bot runtime       sandboxed iframe → Web Worker (Pyodide | clang-wasm | Yaegi-wasm | CheerpJ)
       │  wss (public feed)  /  wss (auth'd trading, Supabase JWT)
       ▼
Engine ─ Python 3.12 FastAPI, a Render Web Service (1 paid always-on instance; only one server processes orders)
  tick loop → generator → matching → accounts → broadcast
       │ asyncpg (service role)
       ▼
Supabase ─ Postgres (RLS) + Auth (Google, GitHub only) + Storage (datasets)
```

## Repo layout (monorepo)
- `web/`: Next.js App Router, TypeScript. On Vercel, set the project's root directory to `web`.
- `engine/market_core/`: the shared engine, pure Python.
  - `rng.py`, `models/ou.py`, `models/gbm_garch_jump.py`, `flow.py` (bot order flow)
  - `book.py`, `matching.py`, `accounts.py`, `lobby.py` (tick driver)
- `engine/server/`: `app.py`, `ws.py`, `auth.py` (JWKS verification), `persistence.py`, `admin.py`.
- `engine/scripts/make_dataset.py`, `engine/tests/`, `Dockerfile`, `pyproject.toml`.
- `render.yaml` at the repo root: the Render Blueprint, with `rootDir: engine`.
- `sdk/{python,c,cpp,go,java}/`: starter template and harness for each language.
- `supabase/migrations/*.sql`: the schema source of truth, applied through the Supabase MCP.
- Fix `.gitignore`: it currently ignores `*.json` and `*.txt`, which would drop `package.json`, `tsconfig.json`, and similar files. Replace it with standard Node, Next.js, and Python ignores plus `.env*`, and keep ignoring `.mcp.json` explicitly.

## Market model (math and economics)
Prices are integer ticks and quantities are integers.

**Hidden fair value, one per good.** Configured per lobby; presets ship.
- **STABLE.** Discretized Ornstein–Uhlenbeck process: `x_{t+1} = x_t + κ(μ−x_t)Δt + σ√Δt·ε`, with ε ~ N(0,1). This is the market-making playground.
- **VOLATILE.** Log-price follows GBM: `r_t = (μ−½σ_t²)Δt + σ_t√Δt·z_t + J_t`.
  - Volatility follows GARCH(1,1): `σ_t² = ω + α·ε²_{t−1} + β·σ²_{t−1}`, which produces volatility clustering.
  - `z_t` is a standardized Student-t(ν), which produces fat tails.
  - `J_t` are Merton jumps, arriving as Poisson(λΔt) with sizes ~ N(μ_J, σ_J).

**Bot order flow.** It depends only on the seed, the tick, and the fair-value path, never on what participants do. That's what keeps the dataset 1:1 with the live market.
- **Bot market maker.** Quotes around fair value. Its spread widens as volatility rises, in the spirit of Glosten–Milgrom. It replaces its quotes every tick.
- **Noise traders.** Zero-intelligence agents in the style of Gode–Sunder and Smith–Farmer:
  - Arrivals per tick ~ Poisson(λ); side ~ Bernoulli(½).
  - Limit offset from fair value ~ Exponential(θ). Orders with negative offsets cross the spread, so they act as market orders.
  - Order size ~ Geometric.
- **Informed trader.** Kyle-style: occasionally trades toward the fair value h ticks ahead. This creates adverse selection for anyone making markets.

**RNG.** NumPy `Generator(PCG64DXSM)` with independent `SeedSequence` streams per good and per process. Pin the NumPy version for bit-exact reproducibility. The seed comes from `secrets.randbits(128)`, or the admin can override it.

## Exchange rules (engine)
**The tick loop.** The tick length `tick_ms` defaults to 1000. For each tick `t`:
1. Send each live bot its private state, plus the public market feed.
2. Collect orders tagged `t` until the deadline (`tick_ms` minus a margin). Late orders are dropped and counted.
3. Generate the bot events for `t`.
4. Shuffle all actions for the tick, seeded by (seed, t).
5. Match with price-time priority.
6. Update positions and cash, persist asynchronously, and broadcast.

**Participant API.** The same in every language:
- `Order(good, price, qty±, tif=GTC|IOC)`, `Cancel(order_id)`, `cancel_all(good)`.
- Resting GTC orders are maker liquidity that other groups can hit.
- When a bot disconnects, its resting orders are cancelled.

**Limits, all enforced on the server:**
- Position limit per good. An order is rejected if it could push the position past the limit.
- Maximum orders per tick and maximum open orders.
- A price band around the mid.
- Maker and taker fees are configurable and default to 0.

**Scoring.**
- Score = cash + Σ position × fair value at the end.
- The live leaderboard marks positions to the mid price.
- Fair value stays hidden from participants until the lobby ends. Admins can see it live.

**Lobby start.** The engine runs the bot-only flow for ticks `0…K−1`, exactly the computation that produced the dataset, to rebuild the book. Live trading then starts at tick `K`, and `/` preloads ticks `0…K−1` as chart history.

**Crash recovery.** Re-run the generator up to the current tick, then replay the persisted participant order log. The engine is deterministic, so the rebuilt state is exact.

## Supabase (set up through the Supabase MCP: create project, `apply_migration`, `get_advisors`, generate TS types)
**Tables:**
- `profiles`: created by a trigger when a row is added to `auth.users`. Has `is_admin`, set from an `admin_allowlist` table seeded with your email.
- `groups`: id, slug, name. Readable by everyone, because names appear on the leaderboard.
- `group_invites`: group_id, token. Admins only.
- `group_members`: `unique(user_id)` enforces one group per user.
- `lobbies`: status, `config jsonb` (goods, model params, `tick_ms`, K, duration, limits, fees), `max_groups`. Readable by everyone.
- `lobby_secrets`: lobby_id, seed. Admins and the service role only.
- `lobby_entries`: lobby_id, group_id, `active_submission_id`, `live_user_id`. A trigger enforces `max_groups`.
- `submissions`: group_id, author_id, language enum (python, java, c, cpp, go), source, sha256, version. Immutable once inserted.
- `datasets`: metadata for files in the `datasets` Storage bucket.
- Engine-written tables: `orders` (replay log), `fills`, `pnl_snapshots`, `market_snapshots`.

**Row-level security (RLS) and protections:**
- RLS is enabled on every table.
- Two helper functions, `private.is_admin()` and `private.is_member(group_id)`, run as `SECURITY DEFINER` with `search_path=''`, and policies call them through `(select …)` so each call is cached per statement.
- Submissions can be read only by members of the same group. Admins can read every group's code for moderation; this is one policy to remove if you don't want it.
- Users can update only their own display name. A trigger blocks changes to `is_admin` by anyone who isn't an admin.
- RPCs, all `SECURITY DEFINER`:
  - `join_group(token)` validates the token and enforces one group per user.
  - `rotate_invite(group_id)` is admin-only.
  - `set_active_submission(lobby_id, submission_id)` is member-only.

**Auth:**
- Google and GitHub providers only, with email/password turned off.
- Enable asymmetric JWT signing keys so the engine can verify tokens against `…/auth/v1/.well-known/jwks.json`.
- **Manual steps for you:**
  - Create a Google OAuth client and a GitHub OAuth App, each with callback URL `https://<ref>.supabase.co/auth/v1/callback`.
  - Paste the credentials into Supabase Dashboard → Auth → Providers.
  - Set the Site URL and the redirect allowlist: localhost plus the Vercel production and preview domains.

## Web app (Next.js 16, `@supabase/ssr`)
**Auth plumbing:**
- `web/lib/supabase/{client,server,proxy}.ts`.
- `web/proxy.ts` refreshes the session on every request, following the Supabase `updateSession` pattern; `proxy` is Next 16's new name for middleware.
- `app/login` has the "Continue with Google" and "Continue with GitHub" buttons, which call `signInWithOAuth`.
- `app/auth/callback/route.ts` calls `exchangeCodeForSession` and accepts only relative `next` redirects.

**`/` (public):**
- For each good: a price chart (`lightweight-charts`), an order-book depth ladder, and a trade tape.
- The leaderboard, plus the lobby's status and countdown.
- **Admin panel, shown only to admins:**
  - Create groups, then copy or rotate their invite links.
  - Create lobbies: goods and presets, seed (auto-generated or overridden), K, `tick_ms`, duration, N, limits, fees.
  - Add groups to a lobby; start, pause, or end it.
  - Promote or demote admins; see the hidden fair value.

**`/join/[token]`:** if not signed in, go to login first; then call `join_group` and redirect to `/g/[slug]`.

**`/g/[slug]`:** members only, checked on the server plus RLS. Non-members get a 404.
- Overview and Live: start the active bot, console output, positions, fills, PnL.
- `/g/[slug]/code`: Monaco editor (`@monaco-editor/react`), language picker defaulting to Python, starter templates, and a save button that creates a new immutable submission version.
- `/g/[slug]/submissions/[id]`: read-only view of any teammate's code, plus "set active".
- `/g/[slug]/backtest`: run a submission against the dataset.

## Client-side bot runtimes
**Shared interface.** Every language implements `Trader.run(state) -> orders (+cancels)`. `state` contains: tick, order depths, own orders, last tick's own fills, market trades, positions, cash, and limits. The `Trader` instance stays alive across ticks, so it can keep its own state.

**TypeScript wrapper.** Each runtime sits behind `BotRuntime { init(src), onTick(stateJson) → ordersJson, dispose() }`.

**Sandboxing.** Each runtime runs in a Web Worker inside a sandboxed iframe (`sandbox="allow-scripts"`, which gives it an opaque origin). User code therefore can't reach the user's Supabase session.

**Timeouts.** If the bot misses the tick deadline, that tick is skipped. After 3 misses in a row, the worker is terminated and restarted.

**Per-language runtimes:**
- **Python (default).** Pyodide in a worker, with a `harness.py` that converts JSON to dataclasses.
- **C / C++.** `@yowasp/clang` (Clang 21, about 25 MiB gzipped, loaded only when needed) compiles the user's file, the harness, and a single-header JSON parser into a wasip1 module that exports `tick(ptr, len)`. It runs through a WASI shim (`@bjorn3/browser_wasi_shim`). Compiled modules are cached in IndexedDB, keyed by source hash.
- **Go.** Yaegi, a Go interpreter, compiled to js/wasm, with the SDK types pre-registered through `interp.Use`. LiveCodes runs Go in the browser the same way, which shows the approach works.
- **Java.** CheerpJ (Java 8, 11, and 17) runs `javac` inside the browser, the way JavaFiddle does, and then runs the harness. **Risks:**
  - Licensing: the hosted runtime is free for non-commercial use, but academic organizations are asked to confirm eligibility with Leaning Technologies.
  - Compiling is slow.
  - Fallback: run the Java harness locally through `sdk/` instead.

**Backtester.** The `book`, `matching`, and `accounts` modules are packaged as a pure-Python wheel and served from `web/public/py/`. It runs in Pyodide and replays the dataset's bot events against the user's bot, producing a PnL chart and a fill log. It uses the same matching code as the live engine, so with no other groups present, a backtest matches what the live engine would do. The generator and seeds never ship to the browser.

**Dataset files**, kept in the Storage bucket and readable by any signed-in user:
- `events.jsonl.gz`: bot events, used for the replay.
- `prices.csv` and `trades.csv`: for analysis in pandas.

## Engine service (FastAPI)
**WebSocket endpoints:**
- `WS /ws/market/{lobby}`: public. A depth, trades, and mid snapshot every tick, plus the leaderboard every N ticks.
- `WS /ws/trade/{lobby}`: the client's first message carries the JWT. The engine verifies it with PyJWT's `PyJWKClient` and looks up the user's group and lobby entry. Only one live connection per group is allowed; a new one takes over the old.

**Admin REST.** `start`, `pause`, `stop`, and `make-dataset` are called from Next.js server actions with the user's JWT. The engine then checks `is_admin` in the database.

**Other details:**
- Persistence goes through `asyncpg`, writing in batches.
- A CORS and origin allowlist limits connections to the Vercel domains.
**Deploying on Render:**
- `render.yaml` defines one `type: web` service with `runtime: docker`, `rootDir: engine`, and `healthCheckPath: /health`.
- Secrets use `sync: false`: `SUPABASE_DB_URL`, `SUPABASE_URL`, `ALLOWED_ORIGINS`.
- Use a paid, always-on instance type. Free instances shut down when idle, which would kill a running lobby.
- Once the Render plugin is installed and authenticated, use it to create the service, set environment variables, and watch deploys and logs.
- **Single runner, enforced in Postgres.** A Render deploy briefly runs the old and new instances side by side. Each lobby's tick loop therefore holds a Postgres advisory lock on that lobby. A new instance waits for the lock, then resumes using crash recovery, so no tick is processed twice.
- **No deploys during a live lobby.** Turn off auto-deploy for the event; a deploy also drops every WebSocket. Clients reconnect with exponential backoff and authenticate again.

## Phases
0. **Prerequisites.**
   - Authenticate the Supabase MCP (run `/mcp`; it's currently unauthenticated).
   - Create the Google and GitHub OAuth apps.
   - Set up Render and Vercel accounts. Install the Render plugin yourself by typing `/plugin install render@claude-plugins-official` at the prompt.
   - Fix `.gitignore` and scaffold the monorepo.
1. **`market_core`.** RNG, both price models, bot flow, order book and matching, accounts, `make_dataset.py`, and tests.
2. **Supabase.** Create the project, apply the migrations (schema, RLS, RPCs, Storage bucket), clear the security warnings from `get_advisors`, and generate TS types.
3. **Web.** Auth, `/` skeleton and admin panel, invites and `/join`, group pages, editor and submissions.
4. **Engine service.** Tick loop, both WebSocket endpoints, JWT auth, persistence, recovery, and the lobby lock. Deploy to Render, then connect the live `/` view.
5. **Runtimes.** Python end to end first (backtest and live). Then C/C++, Go, and Java.
6. **Polish.** Leaderboard, end-of-lobby fair-value reveal, SDK docs page, load test, dry run.

## Verification
**pytest:**
- The same seed produces an identical event-stream hash.
- The dataset matches the first `K` ticks of a live run with no participants, tick for tick.
- Book invariants hold, checked with Hypothesis: no crossed book after matching, and quantity is conserved.
- Position limits and fees are enforced correctly.
- The models show the stylized facts: excess kurtosis above 0 for VOLATILE returns, positive autocorrelation of |r| (volatility clustering), and OU half-life ≈ ln2/κ.

**RLS:**
- SQL tests that set `role authenticated` with fake JWT claims and confirm a member of group A gets 0 rows from group B's submissions, invites, and secrets.
- The Supabase MCP `get_advisors` reports no security warnings.

**End to end (local engine + `next dev`):**
- Sign in with Google in one browser and GitHub in another, create 2 groups, and join each through its invite link.
- Save Python bots and backtest them; the backtest PnL equals an engine replay of the same dataset.
- Start the lobby. Confirm tick `K` continues the dataset's final book and prices.
- Confirm a maker order from group A fills against a taker order from group B, with both sides recorded.
- Repeat with each language's starter template.

**Load:** a headless Python client that simulates N = 20 groups at 500 ms ticks against the deployed Render service. Check that tick-processing latency stays well under the deadline.

**Redeploy drill:** trigger a Render deploy during a test lobby. Confirm that only one instance holds the lobby lock, the tick sequence has no gaps or duplicates, and clients reconnect on their own.

## Known limitations
- Bots run on the client, so the engine can't prove which code a group is actually running. It enforces every market rule, and submissions are logged for audit.
- A bot runs only while the member who started it keeps the tab open, and its resting orders are cancelled when it disconnects.
