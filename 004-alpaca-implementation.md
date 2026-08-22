# 004 — Alpaca Implementation Plan

**Project:** Tiny Bloomberg  
**Phase:** 0 — Replace Stooq with Alpaca Market Data API  
**Date:** 2026-08-21  
**Source spec:** `004-alpaca-migration-plan.md`

---

## Context

The current `tiny-bloomberg/src/index.ts` uses Stooq CSV. Stooq failed in a real integration test (browser-verification page instead of CSV). This plan replaces Stooq with Alpaca's REST API while preserving every public contract: `POST /collect`, `GET /latest/SPY`, the `DailyBar` schema, and the normalized R2 paths.

The 20 steps below are ordered so that each step can be completed independently and validated before moving to the next. All code work happens inside `tiny-bloomberg/`.

---

## Steps

### Step 1 — Git checkpoint + feature branch

**Goal:** clean, recoverable starting point.

```bash
cd tiny-bloomberg
git add .
git commit -m "Checkpoint Stooq provider implementation"
git switch -c phase0-alpaca
```

Verify no secrets are staged:

```bash
git status
git diff --cached
```

`.dev.vars` must not appear in the staged set.

---

### Step 2 — Prove Alpaca works from terminal (Gate A)

**Goal:** confirm credentials, feed, and endpoint before touching any code.

```bash
curl \
  -H "APCA-API-KEY-ID: YOUR_KEY" \
  -H "APCA-API-SECRET-KEY: YOUR_SECRET" \
  "https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=2026-08-14&end=2026-08-21&adjustment=all&feed=iex&limit=100"
```

**Gate A — do not proceed until:**
- HTTP 200 received
- Response is JSON
- `bars` array is present and non-empty
- OHLC values for SPY look plausible

If this fails, fix credentials / account / feed before writing any code.

---

### Step 3 — Add Alpaca credentials to `.dev.vars`

**Goal:** local Worker can pick up secrets without committing them.

Open `tiny-bloomberg/.dev.vars` and add (alongside the existing `COLLECT_TOKEN`):

```text
ALPACA_API_KEY_ID=<your-key>
ALPACA_API_SECRET_KEY=<your-secret>
```

Verify the file is git-ignored:

```bash
git check-ignore tiny-bloomberg/.dev.vars
git status
```

`.dev.vars` must not appear as a file ready to commit.

---

### Step 4 — Extend `Env` interface with Alpaca secrets

**Goal:** TypeScript knows the two new secrets exist.

In `tiny-bloomberg/src/index.ts`, change:

```ts
interface Env {
    MARKET_DATA: R2Bucket;
    COLLECT_TOKEN: string;
}
```

to:

```ts
interface Env {
    MARKET_DATA: R2Bucket;
    COLLECT_TOKEN: string;
    ALPACA_API_KEY_ID: string;
    ALPACA_API_SECRET_KEY: string;
}
```

Do **not** add the values to `wrangler.jsonc`. They are secrets only.

Also update `tiny-bloomberg/wrangler.jsonc` to document the new secret names in a comment (names only, never values):

```jsonc
// Secrets set via:
//   npx wrangler secret put COLLECT_TOKEN
//   npx wrangler secret put ALPACA_API_KEY_ID
//   npx wrangler secret put ALPACA_API_SECRET_KEY
```

---

### Step 5 — Add minimal Alpaca response types

**Goal:** typed surface for Alpaca JSON without importing any SDK.

Add to `tiny-bloomberg/src/index.ts` (after the `DailyBar` interface):

```ts
interface AlpacaBar {
    t: string;   // ISO timestamp
    o: number;   // open
    h: number;   // high
    l: number;   // low
    c: number;   // close
    v: number;   // volume
}

interface AlpacaBarsResponse {
    bars?: AlpacaBar[];
    symbol?: string;
    next_page_token?: string | null;
}
```

Model only the fields Phase 0 actually consumes.

---

### Step 6 — Replace `normalizeStooqDaily` with `normalizeAlpacaDaily`

**Goal:** clean normalization function with no Stooq references; Alpaca field names stay inside this function only.

Remove `normalizeStooqDaily()` entirely. Replace with:

```ts
function normalizeAlpacaDaily(payload: AlpacaBarsResponse, collectedAt: string) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid Alpaca bars response');
    }
    if (!Array.isArray(payload.bars) || payload.bars.length === 0) {
        throw new Error('Alpaca returned no daily bars');
    }

    const bars: DailyBar[] = payload.bars.map((bar) => {
        if (
            !bar.t ||
            !Number.isFinite(bar.o) ||
            !Number.isFinite(bar.h) ||
            !Number.isFinite(bar.l) ||
            !Number.isFinite(bar.c) ||
            !Number.isFinite(bar.v) ||
            bar.h < bar.l
        ) {
            throw new Error(`Invalid Alpaca bar for timestamp ${bar.t ?? 'unknown'}`);
        }
        return {
            date: bar.t.slice(0, 10),
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
        };
    });

    bars.sort((a, b) => b.date.localeCompare(a.date));

    return {
        schemaVersion: 1,
        symbol: 'SPY',
        assetType: 'ETF',
        currency: 'USD',
        frequency: 'daily',
        source: 'alpaca',
        collectedAt,
        bars,
    };
}
```

The `DailyBar` interface itself is **unchanged**.

---

### Step 7 — Create `fetchAlpacaDaily(env)`

**Goal:** isolated function that owns all HTTP communication with Alpaca; returns raw parsed JSON.

Add to `tiny-bloomberg/src/index.ts`:

```ts
async function fetchAlpacaDaily(env: Env): Promise<AlpacaBarsResponse> {
    if (!env.ALPACA_API_KEY_ID || !env.ALPACA_API_SECRET_KEY) {
        throw new Error('Alpaca credentials are not configured');
    }

    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 14);

    const url = new URL('https://data.alpaca.markets/v2/stocks/SPY/bars');
    url.searchParams.set('timeframe', '1Day');
    url.searchParams.set('start', start.toISOString());
    url.searchParams.set('end', end.toISOString());
    url.searchParams.set('adjustment', 'all');
    url.searchParams.set('feed', 'iex');
    url.searchParams.set('limit', '100');

    const response = await fetch(url.toString(), {
        headers: {
            'APCA-API-KEY-ID': env.ALPACA_API_KEY_ID,
            'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET_KEY,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Alpaca HTTP ${response.status}`);
    }

    return response.json() as Promise<AlpacaBarsResponse>;
}
```

Key constraints:
- 14-calendar-day window (handles weekends + holidays)
- Never log or return credentials
- HTTP error → throw with status code

---

### Step 8 — Rewrite `collectSpy()` using the new functions

**Goal:** `collectSpy` orchestrates auth, fetch, normalize, store — delegating to the two functions above. No Stooq references remain.

Replace the body of `collectSpy()`:

1. Keep the existing `Authorization: Bearer` guard at the top.
2. Call `fetchAlpacaDaily(env)` wrapped in try/catch → return `502` on failure.
3. Call `normalizeAlpacaDaily(rawPayload, collectedAt)` wrapped in try/catch → return `502` on validation failure.
4. Store raw payload as JSON under `raw/alpaca/daily/SPY/<timestamp>.json` with `Content-Type: application/json`.
5. Store normalized JSON under `normalized/daily/SPY/<timestamp>.json`.
6. Overwrite `normalized/daily/SPY/latest.json`.
7. Return JSON response with `source: "alpaca"`.

Updated success response shape:

```json
{
  "status": "ok",
  "symbol": "SPY",
  "source": "alpaca",
  "records": 10,
  "latestMarketDate": "2026-08-20",
  "rawObject": "raw/alpaca/daily/SPY/...",
  "normalizedObject": "normalized/daily/SPY/...",
  "collectedAt": "..."
}
```

Error classification:
- Missing credentials → `502` + `"Alpaca credentials are not configured"`
- HTTP 401/403/429/5xx → `502` + `"Alpaca HTTP <status>"`
- Invalid response structure → `502` + `"Invalid Alpaca bars response"`
- Empty bars → `502` + `"Alpaca returned no daily bars"`

---

### Step 9 — Search and remove all remaining Stooq references

**Goal:** implementation code contains zero Stooq references.

```bash
grep -Rni "stooq" tiny-bloomberg/src tiny-bloomberg/test tiny-bloomberg/wrangler.jsonc
```

Review each match. Documentation files (`*.md`) may still mention Stooq; implementation code must not.

Also verify no credentials were accidentally typed into source files:

```bash
git diff
git status
```

---

### Step 10 — Add Alpaca-specific unit tests

**Goal:** 7 targeted tests for the new provider logic, no real network calls.

File: `tiny-bloomberg/test/index.spec.ts` — add to the existing `describe` block.

Tests to add:

| # | Name | What to verify |
|---|------|---------------|
| T1 | `normalizeAlpacaDaily — valid payload` | correct field mapping, `source: "alpaca"`, `schemaVersion: 1`, bars sorted newest-first |
| T2 | `normalizeAlpacaDaily — empty bars throws` | `bars: []` → throws |
| T3 | `normalizeAlpacaDaily — malformed numeric throws` | `o: null` on a bar → throws |
| T4 | `POST /collect without token returns 401` | existing test, keep |
| T5 | `POST /collect — provider HTTP 500 returns 502` | mock `fetch` to return 500; worker returns 502 |
| T6 | `POST /collect — success writes to R2 and returns ok` | mock `fetch` with a valid Alpaca JSON fixture; verify R2 writes, `source: "alpaca"`, `records > 0` |
| T7 | `GET /latest/SPY after collect returns alpaca data` | after T6's R2 writes, call `/latest/SPY`; verify `source: "alpaca"` and bars exist |

For T5/T6/T7 use `vitest`'s `vi.spyOn(globalThis, 'fetch')` to mock the outbound call.

---

### Step 11 — Run static checks

**Goal:** zero TypeScript errors, all tests green.

```bash
cd tiny-bloomberg
npm test
npx tsc --noEmit
```

Both must pass with no new errors or warnings before continuing.

---

### Step 12 — Local end-to-end test (Gate B)

**Goal:** full local pipeline exercised manually with real credentials.

```bash
npm run dev
```

In another terminal:

```bash
# Health
curl http://localhost:8787/health

# Collect
curl -X POST http://localhost:8787/collect \
  -H "Authorization: Bearer <COLLECT_TOKEN>"

# Read latest
curl http://localhost:8787/latest/SPY
```

**Gate B — do not deploy until:**
- `/health` → `{ "status": "ok" }`
- `/collect` → `status: "ok"`, `source: "alpaca"`, `records > 0`, plausible `latestMarketDate`
- `/latest/SPY` → valid normalized bars, `source: "alpaca"`, newest-first, plausible OHLC

---

### Step 13 — Configure Cloudflare production secrets

**Goal:** Alpaca credentials available in the deployed Worker.

```bash
cd tiny-bloomberg
npx wrangler secret put ALPACA_API_KEY_ID
npx wrangler secret put ALPACA_API_SECRET_KEY
npx wrangler secret put COLLECT_TOKEN   # if not already set
```

Verify via Cloudflare dashboard or:

```bash
npx wrangler secret list
```

Never add secret values to `wrangler.jsonc` or commit them.

---

### Step 14 — Deploy + production collection test (Gate C)

**Goal:** the deployed Cloudflare Worker can reach Alpaca and write to production R2.

```bash
npm run deploy
```

In a second terminal, start live logs:

```bash
npx wrangler tail
```

Then test:

```bash
curl https://<worker-url>/health
curl -X POST https://<worker-url>/collect \
  -H "Authorization: Bearer <COLLECT_TOKEN>"
curl https://<worker-url>/latest/SPY
```

**Gate C — this is the critical Phase-0 gate:**
- `POST /collect` returns `status: "ok"` and `source: "alpaca"` from the **deployed** Worker
- This proves `Cloudflare Worker → Alpaca → R2`, not just `Mac → Alpaca`

If Gate C fails, check Cloudflare secrets, `wrangler tail` logs, and Alpaca response status. Do not add Cron until Gate C passes.

---

### Step 15 — Verify production R2 objects

**Goal:** confirm correct R2 key layout written by the deployed Worker.

```bash
npx wrangler r2 object get \
  tiny-bloomberg-data/normalized/daily/SPY/latest.json \
  --remote --pipe
```

Expected object families in R2:

```text
raw/alpaca/daily/SPY/<timestamp>.json
normalized/daily/SPY/<timestamp>.json
normalized/daily/SPY/latest.json
```

Verify the normalized object contains:
- `source: "alpaca"`
- Recent SPY bars with plausible OHLC values

---

### Step 16 — Commit provider migration

**Goal:** clean git record of the Stooq → Alpaca swap.

```bash
cd ..  # workspace root
git status
git diff
git add tiny-bloomberg/src tiny-bloomberg/test tiny-bloomberg/wrangler.jsonc
git commit -m "Replace Stooq with Alpaca market data"
git push -u origin phase0-alpaca
```

Only stage files that actually changed. Do not stage `.dev.vars`, `node_modules/`, or generated files.

---

### Step 17 — Extract `runSpyCollection(env)` for Cron reuse

**Goal:** one function contains the collection logic; both `/collect` HTTP handler and the Cron handler call it — no duplication.

Refactor:

```ts
async function runSpyCollection(env: Env): Promise<CollectionResult> {
    // fetchAlpacaDaily → normalizeAlpacaDaily → R2 writes
    // returns { symbol, source, records, latestMarketDate, rawObject, normalizedObject, collectedAt }
}
```

Update `collectSpy()` to:
1. Check `Authorization: Bearer` — return `401` if invalid.
2. Call `runSpyCollection(env)` — return `502` on error, `200 + JSON` on success.

`runSpyCollection` has no HTTP concerns. It only knows `Env` and R2.

---

### Step 18 — Add idempotency (safe rerun)

**Goal:** running collection twice for the same market day does not create duplicate logical observations.

Before writing the normalized daily record, check for existence of a canonical per-date object:

```ts
const canonicalKey = `normalized/daily/SPY/by-date/${marketDate}.json`;
const existing = await env.MARKET_DATA.get(canonicalKey);
```

If `existing` is non-null:
- Still refresh `normalized/daily/SPY/latest.json` (so `/latest/SPY` stays current).
- Return `{ "status": "no_change", "symbol": "SPY", "source": "alpaca", "latestMarketDate": "..." }`.

If `existing` is null:
- Write the canonical per-date object.
- Write the timestamped normalized object.
- Write `latest.json`.
- Return `{ "status": "ok", ... }`.

Raw timestamped payloads under `raw/alpaca/daily/SPY/` may still accumulate during Phase 0 for debugging.

---

### Step 19 — Add Cloudflare Cron Trigger

**Goal:** automatic collection at 23:00 UTC Monday–Friday without manual intervention.

**19a.** Add to `tiny-bloomberg/wrangler.jsonc`:

```jsonc
"triggers": {
    "crons": ["0 23 * * mon-fri"]
}
```

**19b.** Add `scheduled` handler to the Worker export in `tiny-bloomberg/src/index.ts`:

```ts
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // ... existing routing ...
    },

    async scheduled(
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        ctx.waitUntil(runSpyCollection(env));
    },
} satisfies ExportedHandler<Env>;
```

**19c.** Run `npm run cf-typegen` to regenerate `worker-configuration.d.ts` after the `wrangler.jsonc` change.

Test locally:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+23+*+*+mon-fri"
```

**Gate D — run the scheduled trigger twice:**
- First run → stores the current market date canonical object
- Second run → `status: "no_change"`, no duplicate logical observation

---

### Step 20 — Deploy Cron + final validation

**Goal:** Phase 0 is complete; collection runs automatically.

```bash
npm run deploy
npx wrangler tail
```

Inspect Cloudflare dashboard → Workers → `tiny-bloomberg` → Cron Triggers. Confirm the schedule appears.

Final checklist (must all be true before closing Phase 0):

- [ ] Alpaca direct `curl` works
- [ ] Alpaca credentials stored as Cloudflare secrets only — never in Git
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Local `/health` returns ok
- [ ] Local `/collect` returns `source: "alpaca"`
- [ ] Local `/latest/SPY` returns valid normalized bars
- [ ] Deployed Worker can call Alpaca (Gate C)
- [ ] Production R2 contains `raw/alpaca/...` and `normalized/daily/SPY/...`
- [ ] `normalized/daily/SPY/by-date/` per-date canonical objects exist
- [ ] Running collection twice for the same market day is safe
- [ ] Cloudflare Cron appears in dashboard
- [ ] `wrangler tail` shows successful scheduled execution
- [ ] Mac can be turned off and collection still occurs

---

## File change summary

| File | Change |
|------|--------|
| `tiny-bloomberg/src/index.ts` | Remove `normalizeStooqDaily`; add `AlpacaBar`, `AlpacaBarsResponse`, `fetchAlpacaDaily`, `normalizeAlpacaDaily`, `runSpyCollection`; update `Env`, `collectSpy`, and the default export |
| `tiny-bloomberg/wrangler.jsonc` | Add cron trigger; update secret-name comments |
| `tiny-bloomberg/.dev.vars` | Add `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` (local only, never committed) |
| `tiny-bloomberg/test/index.spec.ts` | Add T1–T3 normalizer unit tests and T5–T7 integration tests with mocked fetch |
| `tiny-bloomberg/test/env.d.ts` | No change needed (extends `Env` which is updated in `index.ts`) |
| `tiny-bloomberg/worker-configuration.d.ts` | Regenerated by `npm run cf-typegen` after `wrangler.jsonc` change |
