# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Architecture constraints (non-obvious only)

- **Tests run inside workerd, not Node** — `@cloudflare/vitest-pool-workers` spawns the real Workers runtime for each test. This means Node-only APIs, Node globals, and standard vitest environment assumptions do not apply.
- **`Env` is entirely generated** — bindings in `wrangler.jsonc` drive the `Env` interface. Adding a binding without running `cf-typegen` will silently leave `Env` stale.
- **`raw/` and `snapshots/` are immutable by design** — the system's recoverability depends on these never being overwritten. `series/` and `system/latest.json` are the only mutable paths.
- **Idempotency is a hard requirement** — the architecture assumes reruns are safe. Any storage write must check for prior existence before writing. This enables manual recovery without risk.
- **One-symbol failure must not fail the batch** — symbols are independent processing units; the collection loop may not use `Promise.all` with shared rejection.
- **Alpha Vantage is the only external dependency in Stage 1** — it has a 25 req/day cap on the free tier. Every design decision around data freshness, retry logic, and symbol count must respect this ceiling.
- **Admin endpoints need a separate secret from the market-data key** — two distinct secrets: `ALPHA_VANTAGE_KEY` (data collection) and an admin bearer (manual trigger/rebuild). The frontend receives neither.
- **Cron is the primary trigger; HTTP is the recovery path** — `POST /api/admin/collect` is the manual override, not the normal execution path.
- **`system/latest.json` is the dashboard hot path** — designed for one cheap R2 read per page load, not a query across `series/` or `snapshots/`.
- **Stage 1 scope is intentionally narrow** — no LLMs, no intraday, no user accounts, no AWS, no databases. Scope creep must be rejected against `001-architecture.md §2`.
- **The spec is the contract** — `001-architecture.md` defines R2 key layout, endpoint shapes, log structure, and data schema. Deviating from those paths will break the admin `rebuild-series` endpoint and any external tooling.
