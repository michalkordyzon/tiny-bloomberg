# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Coding rules (non-obvious only)

- **All commands run from `tiny-bloomberg/`** — not the workspace root.
- **`npm run cf-typegen` is mandatory** after any `wrangler.jsonc` binding change; otherwise `Env` is stale and TypeScript will fail.
- **Worker export pattern:** use `export default { ... } satisfies ExportedHandler<Env>` — the `addEventListener("fetch", ...)` style does not work with the current setup.
- **Test helpers come from `"cloudflare:test"`** — never from Node or vitest globals. The pool runs inside workerd, not Node.
- **`test/` is excluded from the main `tsconfig.json`** — it has its own `test/tsconfig.json` with `@cloudflare/vitest-pool-workers` types. Merging them will break type resolution.
- **`test/env.d.ts` must be updated** when new bindings are added — it extends `ProvidedEnv` so test helpers see the correct `Env` type.
- **Tabs, not spaces** — the entire project uses tabs (`.prettierrc` + `.editorconfig`). Editors default to spaces; check before submitting.
- **`worker-configuration.d.ts` is generated** — do not hand-edit. It is overwritten by `wrangler types`.
- **Idempotency contract:** before writing any R2 key under `snapshots/` or `raw/`, check existence first — skip silently if present. This prevents duplicate market observations on reruns.
- **Secrets via `wrangler secret put`** — never `vars` in `wrangler.jsonc`. `ALPHA_VANTAGE_KEY` and the admin bearer token must be secrets only.
- **Alpha Vantage quota:** 25 req/day free. Current design: 5 symbols × 1 endpoint = 5/day. Do not add calls or symbols without accounting for the budget.
- **Partial-failure pattern:** wrap each symbol's collection in its own try/catch and accumulate results; never `Promise.all` with early rejection.
- **Cron trigger:** configured in `wrangler.jsonc` under `triggers.crons`, not in application code.
- **Structured log shape:** `{ event, runId, requested, succeeded, failed, latestMarketDate, durationMs }` — see `001-architecture.md §7`.
- **R2 key layout must match the spec exactly** — other tools (`rebuild-series`, admin endpoints) depend on deterministic paths. See `001-architecture.md §5`.
