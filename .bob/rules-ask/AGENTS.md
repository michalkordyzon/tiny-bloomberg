# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Documentation context (non-obvious only)

- **`001-architecture.md`** is the canonical spec — architecture, data schema, R2 key layout, collection workflow, reliability rules, endpoint contracts, testing requirements, and implementation sequence.
- **`002-implementation.md`** is the step-by-step Day 1 guide — exact commands, wrangler setup, R2 binding, secret injection, normalization contract, and the three routes to implement first (`/health`, `/collect`, `/latest/SPY`).
- **`tiny-bloomberg/src/index.ts`** is currently a blank scaffold — the architecture described in `001-architecture.md` has not been implemented yet. Do not assume production code exists.
- **`worker-configuration.d.ts`** is auto-generated types — not representative of final bindings. It reflects only what has been added to `wrangler.jsonc` so far.
- **`test/`** has its own `tsconfig.json` — excluded from the main `tsconfig.json`. This is intentional, not a mistake.
- **No ESLint config exists** — only Prettier (`.prettierrc`) and TypeScript strict mode enforce style.
- **`system/latest.json`** in R2 is the performance-critical path — the dashboard homepage reads only this file, not the full `snapshots/` tree.
- **`series/<SYMBOL>.json`** is a bounded projection rebuilt from `snapshots/` — it is disposable, the snapshots are the source of truth.
