# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project

**Tiny Bloomberg** — a Cloudflare Worker (TypeScript) that collects daily OHLCV market data from Alpha Vantage, stores it in R2, and serves it via a JSON API. See [`001-architecture.md`](001-architecture.md) and [`002-implementation.md`](002-implementation.md) for full spec.

All worker code lives in [`tiny-bloomberg/`](tiny-bloomberg/). Run all commands from that directory.

## Commands

```bash
cd tiny-bloomberg
npm run dev          # wrangler dev — local at http://localhost:8787
npm test             # vitest (runs inside workerd via @cloudflare/vitest-pool-workers)
npm run deploy       # wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts from wrangler.jsonc bindings
```

**Single test:** `npx vitest run test/index.spec.ts` (from `tiny-bloomberg/`)

Run `npm run cf-typegen` after adding/changing any binding in `wrangler.jsonc`.

## Testing — non-obvious

Tests run **inside the real Workers runtime** (workerd) via `@cloudflare/vitest-pool-workers`, not in Node. This means:

- Import test helpers from `"cloudflare:test"` (`env`, `createExecutionContext`, `waitOnExecutionContext`, `SELF`), not from Node or vitest globals.
- `test/tsconfig.json` extends the root tsconfig and adds `@cloudflare/vitest-pool-workers` types — the `test/` folder is **excluded** from the main `tsconfig.json`.
- `test/env.d.ts` augments `ProvidedEnv` with the worker `Env` interface; add new bindings there after running `cf-typegen`.
- Two test styles are available: **unit** (call `worker.fetch(request, env, ctx)` directly) and **integration** (use `SELF.fetch(url)` which runs through the full worker chain).
- Use `Request<unknown, IncomingRequestCfProperties>` for typed requests in tests (see `test/index.spec.ts`).

## Code style

- **Formatter:** Prettier — tabs (not spaces), single quotes, semicolons, print width 140.
- **TypeScript:** strict mode, `moduleResolution: "Bundler"`, `module: "es2022"`, target `es2024`. No `noEmit`-bypass tricks.
- Worker entry: export `default { async fetch(request, env, ctx): Promise<Response> {} } satisfies ExportedHandler<Env>` — not `addEventListener`.
- `Env` type is auto-generated into `worker-configuration.d.ts` by `wrangler types`; do not hand-edit it.

## Architecture constraints

- **R2 bucket name:** `tiny-bloomberg-data` — bound as `DATA` in `wrangler.jsonc`.
- **API key:** stored as a Worker secret (`ALPHA_VANTAGE_KEY`), never in env vars, `wrangler.jsonc`, or code.
- **Admin endpoints** (`POST /api/admin/*`) must require a bearer secret; never expose to the frontend.
- **Idempotency rule:** writing a market date that already exists in R2 must silently skip, not overwrite.
- **R2 key layout** (from [`001-architecture.md`](001-architecture.md)):
  - `raw/alpha-vantage/YYYY/MM/DD/<SYMBOL>.json` — immutable raw provider response
  - `snapshots/YYYY/MM/DD.json` — immutable normalized daily snapshot
  - `series/<SYMBOL>.json` — replaceable dashboard projection (bounded history)
  - `system/latest.json`, `system/health.json`, `system/runs/<runId>.json`
- **Cron:** weekdays at 23:00 UTC — do not use `setInterval`; configure via `wrangler.jsonc` `triggers.crons`.
- **Alpha Vantage quota:** 25 requests/day on the free tier; 5 symbols × 1 endpoint = 5 requests per run. Never add symbols without checking the quota.
- **Partial failure:** each symbol must be collected independently; one failure must not abort the batch.
- **Structured logs:** emit JSON-shaped log objects (see spec in `001-architecture.md` §7).

## Cloudflare Workers — always fetch fresh docs

⚠️ Your training knowledge of Workers APIs and limits may be outdated. Always retrieve current documentation before implementing Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK features.

- Workers docs: https://developers.cloudflare.com/workers/
- R2: https://developers.cloudflare.com/r2/
- Limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare docs MCP: `https://docs.mcp.cloudflare.com/mcp`
