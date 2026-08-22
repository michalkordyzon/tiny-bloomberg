# 004 — Alpaca Migration Plan

**Project:** Tiny Bloomberg  
**Phase:** 0 — Basic automatic market-data collection  
**Status:** Ready for implementation  
**Date:** 2026-08-21

---

## 1. Objective

Replace **Stooq** with **Alpaca Market Data API** as the source for SPY daily market data.

The migration must preserve the rest of the current Tiny Bloomberg mechanism:

```text
Alpaca
  ↓
Cloudflare Worker
  ↓
validate + normalize
  ↓
Cloudflare R2
  ↓
/latest/SPY
```

The goal of Phase 0 is not to build a full market-data platform.

The goal is to prove that:

> A Cloudflare Worker can automatically obtain valid SPY daily data from a reliable API, normalize it, save it to R2, and expose the latest saved dataset without requiring the laptop to be running.

---

# 2. Current state

The repository currently contains a working skeleton:

- `GET /health`
- protected `POST /collect`
- `GET /latest/SPY`
- R2 binding named `MARKET_DATA`
- normalized daily-bar schema
- raw-object storage
- normalized-object storage
- `latest.json`
- basic Vitest tests

Current main implementation:

```text
tiny-bloomberg/src/index.ts
```

Current source pipeline:

```text
Stooq CSV
   ↓
normalizeStooqDaily()
   ↓
raw/stooq/daily/SPY/<timestamp>.csv
   ↓
normalized/daily/SPY/<timestamp>.json
   ↓
normalized/daily/SPY/latest.json
```

Stooq has now failed a real integration test because its endpoint returned a JavaScript browser-verification page instead of CSV.

Therefore Stooq should be removed from Phase 0.

---

# 3. Scope

## In scope

Implement:

1. Alpaca authentication.
2. Fetch SPY daily bars from Alpaca.
3. Validate Alpaca JSON.
4. Convert Alpaca bars into the existing Tiny Bloomberg normalized schema.
5. Store raw Alpaca JSON in R2.
6. Store normalized data in R2.
7. Preserve `/collect`.
8. Preserve `/latest/SPY`.
9. Add automated tests for the Alpaca adapter.
10. Verify locally.
11. Verify from deployed Cloudflare Worker.
12. Add scheduled collection only after manual production collection succeeds.
13. Make scheduled collection safe to rerun.

## Out of scope

Do **not** add yet:

- more symbols
- stocks other than SPY
- portfolio logic
- technical indicators
- AI/LLM analysis
- dashboards
- databases other than R2
- websockets
- streaming market data
- intraday bars
- trading
- Alpaca SDK
- a generic plugin framework
- queues
- Durable Objects
- D1
- retry frameworks
- alerting systems

Keep Phase 0 small.

---

# 4. Architectural rule

The provider must be replaceable without changing the rest of Tiny Bloomberg.

Target separation:

```text
Alpaca-specific code
        ↓
Tiny Bloomberg normalized DailyBar[]
        ↓
provider-independent storage/API
```

Do not allow Alpaca field names such as:

```text
o
h
l
c
v
t
```

to leak into normalized R2 objects.

---

# 5. Alpaca endpoint

Use the official historical daily-bars endpoint:

```text
GET https://data.alpaca.markets/v2/stocks/SPY/bars
```

Authentication headers:

```text
APCA-API-KEY-ID
APCA-API-SECRET-KEY
```

For Phase 0 use:

```text
timeframe=1Day
feed=iex
adjustment=all
```

`feed=iex` is intentional for Phase 0 because it avoids depending on paid SIP access.

We are currently testing the collection mechanism, not building institutional-quality consolidated market data.

Later phases may evaluate SIP or another provider.

Example request:

```bash
curl \
  -H "APCA-API-KEY-ID: YOUR_KEY" \
  -H "APCA-API-SECRET-KEY: YOUR_SECRET" \
  "https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=2026-08-14&end=2026-08-21&adjustment=all&feed=iex&limit=100"
```

Expected structure is approximately:

```json
{
  "bars": [
    {
      "t": "2026-08-20T04:00:00Z",
      "o": 1,
      "h": 2,
      "l": 1,
      "c": 2,
      "v": 123
    }
  ],
  "symbol": "SPY",
  "next_page_token": null
}
```

Do not depend on undocumented fields.

---

# 6. Step 0 — Protect the current working state

Before Bob modifies anything:

```bash
git status
git diff
git log --oneline --decorate -8
```

If there are useful uncommitted Stooq changes, commit them first so the migration has a clean starting point.

Suggested checkpoint:

```bash
git add .
git commit -m "Checkpoint Stooq provider implementation"
```

Then create a branch:

```bash
git switch -c phase0-alpaca
```

Do not put Alpaca keys into Git.

---

# 7. Step 1 — Prove Alpaca works before writing code

Create an Alpaca account and obtain:

```text
API key ID
API secret key
```

First test Alpaca directly from the terminal.

Use a known historical period:

```bash
curl \
  -H "APCA-API-KEY-ID: YOUR_KEY" \
  -H "APCA-API-SECRET-KEY: YOUR_SECRET" \
  "https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=2026-08-14&end=2026-08-21&adjustment=all&feed=iex&limit=100"
```

### Gate A

Continue only if:

- HTTP response is successful;
- response is JSON;
- `bars` exists;
- at least one bar exists;
- SPY dates and OHLC values look plausible.

If this direct request fails, stop.

Do not modify the Worker until credentials/API access are known to work.

---

# 8. Step 2 — Add local secrets

Create or update:

```text
tiny-bloomberg/.dev.vars
```

Contents:

```text
COLLECT_TOKEN=<existing-local-token>
ALPACA_API_KEY_ID=<alpaca-key>
ALPACA_API_SECRET_KEY=<alpaca-secret>
```

Verify `.dev.vars` is ignored:

```bash
git check-ignore .dev.vars
```

Expected: `.dev.vars` is reported as ignored.

Also run:

```bash
git status
```

The secrets file must not appear as a file ready to commit.

---

# 9. Step 3 — Extend the Worker environment type

Current:

```ts
interface Env {
  MARKET_DATA: R2Bucket;
  COLLECT_TOKEN: string;
}
```

Change to:

```ts
interface Env {
  MARKET_DATA: R2Bucket;
  COLLECT_TOKEN: string;
  ALPACA_API_KEY_ID: string;
  ALPACA_API_SECRET_KEY: string;
}
```

Do not place credentials in `wrangler.jsonc`.

They are secrets.

---

# 10. Step 4 — Keep the normalized schema unchanged

The existing normalized bar should remain:

```ts
interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

The normalized dataset should remain conceptually:

```json
{
  "schemaVersion": 1,
  "symbol": "SPY",
  "assetType": "ETF",
  "currency": "USD",
  "frequency": "daily",
  "source": "alpaca",
  "collectedAt": "...",
  "bars": []
}
```

Only:

```text
source: "stooq"
```

becomes:

```text
source: "alpaca"
```

No schema-version bump is required because the normalized schema itself has not changed.

---

# 11. Step 5 — Define minimal Alpaca response types

Add small internal interfaces.

Example:

```ts
interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  symbol?: string;
  next_page_token?: string | null;
}
```

Do not model every possible Alpaca field.

Model only what Phase 0 consumes.

---

# 12. Step 6 — Replace the Stooq normalizer

Remove:

```ts
normalizeStooqDaily(csv, collectedAt)
```

Replace with something similar to:

```ts
normalizeAlpacaDaily(payload, collectedAt)
```

Responsibilities:

1. Ensure payload is an object.
2. Ensure `bars` is an array.
3. Ensure at least one bar exists.
4. Validate each bar.
5. Convert Alpaca field names into `DailyBar`.
6. Sort newest date first.
7. Return the existing normalized dataset.

Mapping:

```text
Alpaca     Tiny Bloomberg
------     --------------
t          date
o          open
h          high
l          low
c          close
v          volume
```

Date conversion:

```ts
date: bar.t.slice(0, 10)
```

Example normalized bar:

```json
{
  "date": "2026-08-20",
  "open": 642.11,
  "high": 644.50,
  "low": 639.20,
  "close": 643.80,
  "volume": 1234567
}
```

Validation should reject:

- missing timestamp;
- invalid timestamp;
- non-finite OHLC values;
- non-finite volume;
- empty bars array;
- malformed JSON.

Useful invariant:

```ts
high >= low
```

Optional Phase-0 validation:

```ts
open >= 0
high >= 0
low >= 0
close >= 0
volume >= 0
```

Do not over-engineer validation.

---

# 13. Step 7 — Create an Alpaca fetch function

Prefer separating provider communication from normalization.

Target shape:

```ts
async function fetchAlpacaDaily(env: Env): Promise<AlpacaBarsResponse>
```

The function should:

1. calculate a recent date window;
2. create the Alpaca URL;
3. send authentication headers;
4. check HTTP status;
5. parse JSON;
6. return the raw parsed payload.

Recommended collection window for Phase 0:

```text
last 14 calendar days
```

Why:

- enough to survive weekends;
- enough to survive market holidays;
- tiny payload;
- no need to download decades of SPY history every day.

Pseudo-code:

```ts
const end = new Date();
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 14);

const url = new URL(
  'https://data.alpaca.markets/v2/stocks/SPY/bars'
);

url.searchParams.set('timeframe', '1Day');
url.searchParams.set('start', start.toISOString());
url.searchParams.set('end', end.toISOString());
url.searchParams.set('adjustment', 'all');
url.searchParams.set('feed', 'iex');
url.searchParams.set('limit', '100');
```

Request:

```ts
const response = await fetch(url.toString(), {
  headers: {
    'APCA-API-KEY-ID': env.ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET_KEY,
    Accept: 'application/json',
  },
});
```

On an HTTP error:

- return/throw an error containing status code;
- optionally include a short response message;
- never log credentials;
- never return credentials to the caller.

Examples:

```text
Alpaca HTTP 401
Alpaca HTTP 403
Alpaca HTTP 429
Alpaca HTTP 500
```

Do not silently treat an API error as an empty dataset.

---

# 14. Step 8 — Refactor collection into provider-independent logic

Current function combines:

- HTTP authorization;
- Stooq fetch;
- parsing;
- R2 storage.

For Phase 0 do only a small separation.

Target:

```text
collectSpy()
   ↓
fetchAlpacaDaily()
   ↓
normalizeAlpacaDaily()
   ↓
store normalized/raw data
```

Do **not** introduce classes or dependency-injection frameworks.

Simple functions are enough.

---

# 15. Step 9 — Preserve `/collect` authentication

Keep:

```text
POST /collect
Authorization: Bearer <COLLECT_TOKEN>
```

Do not use the Alpaca API key as the `/collect` token.

These credentials solve different problems:

```text
COLLECT_TOKEN
    protects your Worker administration endpoint

ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY
    authenticate Worker → Alpaca
```

---

# 16. Step 10 — Change raw R2 storage format

Current Stooq raw object:

```text
raw/stooq/daily/SPY/<timestamp>.csv
```

New Alpaca raw object:

```text
raw/alpaca/daily/SPY/<timestamp>.json
```

Store the full raw Alpaca response.

Use:

```text
Content-Type: application/json
```

For example:

```ts
await env.MARKET_DATA.put(
  rawKey,
  JSON.stringify(rawPayload),
  {
    httpMetadata: {
      contentType: 'application/json'
    }
  }
);
```

Preserve normalized storage:

```text
normalized/daily/SPY/<timestamp>.json
normalized/daily/SPY/latest.json
```

This means consumers of normalized data do not care whether the upstream provider is Stooq or Alpaca.

---

# 17. Step 11 — Keep the `/collect` response useful

Successful response should be approximately:

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

This response is your first operational diagnostic.

Do not return the Alpaca credentials.

---

# 18. Step 12 — Keep `/latest/SPY` unchanged

The endpoint should continue reading:

```text
normalized/daily/SPY/latest.json
```

No caller should need to know that the provider changed.

After migration:

```bash
curl http://localhost:8787/latest/SPY
```

should return:

```json
{
  "schemaVersion": 1,
  "symbol": "SPY",
  "assetType": "ETF",
  "currency": "USD",
  "frequency": "daily",
  "source": "alpaca",
  "collectedAt": "...",
  "bars": [...]
}
```

---

# 19. Step 13 — Improve error handling

Distinguish the major failure classes.

Examples:

### Credentials missing

```json
{
  "status": "error",
  "message": "Alpaca credentials are not configured"
}
```

### Authentication rejected

```json
{
  "status": "error",
  "message": "Alpaca HTTP 401"
}
```

### Permission/feed issue

```json
{
  "status": "error",
  "message": "Alpaca HTTP 403"
}
```

### Rate limit

```json
{
  "status": "error",
  "message": "Alpaca HTTP 429"
}
```

### Invalid response

```json
{
  "status": "error",
  "message": "Invalid Alpaca bars response"
}
```

### No market data

```json
{
  "status": "error",
  "message": "Alpaca returned no daily bars"
}
```

Provider failures should result in HTTP `502` from Tiny Bloomberg.

Authentication failure on `/collect` should remain `401`.

---

# 20. Step 14 — Tests

Current tests mainly verify routing and authentication.

Add provider tests before production deployment.

## Test 1 — valid Alpaca payload

Fixture:

```json
{
  "bars": [
    {
      "t": "2026-08-20T04:00:00Z",
      "o": 640,
      "h": 645,
      "l": 638,
      "c": 643,
      "v": 1000
    }
  ],
  "symbol": "SPY",
  "next_page_token": null
}
```

Verify normalized result:

```json
{
  "date": "2026-08-20",
  "open": 640,
  "high": 645,
  "low": 638,
  "close": 643,
  "volume": 1000
}
```

Verify:

```text
source = alpaca
symbol = SPY
frequency = daily
schemaVersion = 1
```

## Test 2 — empty bars

Input:

```json
{
  "bars": []
}
```

Expected: normalization fails.

## Test 3 — malformed numeric value

Example:

```json
{
  "t": "2026-08-20T04:00:00Z",
  "o": null
}
```

Expected: normalization fails.

## Test 4 — unauthorized `/collect`

Existing behavior should remain:

```text
POST /collect without token → 401
```

## Test 5 — provider HTTP failure

Mock Alpaca:

```text
HTTP 500
```

Expected Worker response:

```text
502
```

## Test 6 — successful `/collect`

Mock Alpaca response.

Verify:

- HTTP `200`;
- `source = alpaca`;
- normalized object written;
- latest object written;
- raw object written.

## Test 7 — `/latest/SPY`

After simulated collection:

```text
GET /latest/SPY
```

must return the normalized Alpaca dataset.

---

# 21. Step 15 — Run static checks

From:

```text
tiny-bloomberg/
```

run:

```bash
npm test
```

Then:

```bash
npx tsc --noEmit
```

Both must pass.

Then inspect the code changes:

```bash
git diff
```

Search for stale Stooq references:

```bash
grep -Rni "stooq" src test wrangler.jsonc .
```

Review results manually.

Some documentation may still mention Stooq; implementation code should not.

Also search for secrets accidentally inserted into code:

```bash
git diff
git status
```

Never commit an actual Alpaca key.

---

# 22. Step 16 — Local end-to-end test

Start Worker:

```bash
npm run dev
```

Test health:

```bash
curl http://localhost:8787/health
```

Expected:

```json
{
  "service": "tiny-bloomberg",
  "status": "ok"
}
```

Test collection:

```bash
curl -X POST http://localhost:8787/collect \
  -H "Authorization: Bearer <COLLECT_TOKEN>"
```

Expected:

```text
status = ok
source = alpaca
records > 0
latestMarketDate != null
```

Then:

```bash
curl http://localhost:8787/latest/SPY
```

Verify manually:

- symbol is SPY;
- source is alpaca;
- bars exist;
- bars are newest-first;
- latest date looks correct;
- OHLC values are plausible;
- volume is numeric.

### Gate B

Do not deploy until the local end-to-end path works.

---

# 23. Step 17 — Configure Cloudflare production secrets

From:

```text
tiny-bloomberg/
```

set:

```bash
npx wrangler secret put ALPACA_API_KEY_ID
```

Then:

```bash
npx wrangler secret put ALPACA_API_SECRET_KEY
```

Make sure the existing secret also exists:

```bash
npx wrangler secret put COLLECT_TOKEN
```

Do not add the secret values to `wrangler.jsonc`.

Optional comments in `wrangler.jsonc` may document the secret names:

```text
COLLECT_TOKEN
ALPACA_API_KEY_ID
ALPACA_API_SECRET_KEY
```

but never their values.

---

# 24. Step 18 — Deploy

Run:

```bash
npm run deploy
```

Start live logs in another terminal:

```bash
npx wrangler tail
```

Verify:

```bash
curl https://<worker-url>/health
```

Then perform the critical production collection test:

```bash
curl -X POST https://<worker-url>/collect \
  -H "Authorization: Bearer <COLLECT_TOKEN>"
```

Expected:

```json
{
  "status": "ok",
  "symbol": "SPY",
  "source": "alpaca",
  "records": "...",
  "latestMarketDate": "...",
  "rawObject": "...",
  "normalizedObject": "...",
  "collectedAt": "..."
}
```

### Gate C

This is the most important Phase-0 provider gate.

Do not add Cron until this succeeds from the **deployed Cloudflare Worker**.

The requirement is:

```text
Cloudflare Worker → Alpaca → valid response
```

not merely:

```text
Mac → Alpaca
```

---

# 25. Step 19 — Verify production R2

Check:

```bash
curl https://<worker-url>/latest/SPY
```

Also inspect R2 directly.

Expected object families:

```text
raw/alpaca/daily/SPY/
normalized/daily/SPY/
normalized/daily/SPY/latest.json
```

Example:

```bash
npx wrangler r2 object get \
  tiny-bloomberg-data/normalized/daily/SPY/latest.json \
  --remote \
  --pipe
```

Verify the JSON contains:

```text
source: alpaca
```

and recent SPY bars.

---

# 26. Step 20 — Commit the provider migration

After Gate C succeeds:

```bash
git status
git diff
```

Then:

```bash
git add tiny-bloomberg/src tiny-bloomberg/test tiny-bloomberg/wrangler.jsonc
```

Use only the files actually changed.

Commit:

```bash
git commit -m "Replace Stooq with Alpaca market data"
```

Push:

```bash
git push -u origin phase0-alpaca
```

Merge according to the normal repository workflow.

---

# 27. Step 21 — Refactor collection for scheduling

Only now prepare automatic collection.

At the moment `/collect` owns both:

```text
authentication
collection logic
```

Cron cannot call `/collect` with the user's admin token as its internal design.

Extract:

```ts
async function runSpyCollection(env: Env)
```

Target:

```text
POST /collect
    ↓ authenticate COLLECT_TOKEN
runSpyCollection(env)
    ↓
Alpaca → normalize → R2
```

Cron:

```text
scheduled()
    ↓
runSpyCollection(env)
    ↓
Alpaca → normalize → R2
```

This gives exactly one collection implementation.

Do not duplicate collection code between HTTP and Cron.

---

# 28. Step 22 — Add safe rerun / idempotency

Before trusting automation, repeated collection should be safe.

Recommended canonical object:

```text
normalized/daily/SPY/by-date/YYYY-MM-DD.json
```

The newest normalized Alpaca bar determines `marketDate`.

Example:

```text
normalized/daily/SPY/by-date/2026-08-20.json
```

Before writing the daily canonical object:

```ts
const existing =
  await env.MARKET_DATA.get(
    `normalized/daily/SPY/by-date/${marketDate}.json`
  );
```

If it exists, collection may still refresh:

```text
normalized/daily/SPY/latest.json
```

but it should not create another logical daily record.

Possible result:

```json
{
  "status": "no_change",
  "symbol": "SPY",
  "source": "alpaca",
  "latestMarketDate": "2026-08-20"
}
```

Timestamped raw payloads may still be retained during Phase 0 for debugging if desired.

The important requirement is:

> one logical normalized daily observation per market date.

---

# 29. Step 23 — Add Cloudflare Cron Trigger

After production manual collection and idempotency work, add:

```json
"triggers": {
  "crons": ["0 23 * * mon-fri"]
}
```

Cloudflare Cron uses UTC.

This schedule means:

```text
23:00 UTC Monday-Friday
```

This is safely after normal US market close.

Add scheduled handler:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    ...
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runSpyCollection(env));
  }
};
```

Use the same:

```text
runSpyCollection()
```

function used by `/collect`.

---

# 30. Step 24 — Test scheduled execution locally

Run:

```bash
npx wrangler dev --test-scheduled
```

Then trigger:

```bash
curl "http://localhost:8787/__scheduled?cron=0+23+*+*+mon-fri"
```

Verify:

```bash
curl http://localhost:8787/latest/SPY
```

Run the scheduled trigger twice.

The second run must be safe.

### Gate D

Expected:

```text
first run  → stores current market date
second run → no duplicate logical observation
```

---

# 31. Step 25 — Deploy Cron

Deploy:

```bash
npm run deploy
```

Inspect deployment output and Cloudflare dashboard.

Use:

```bash
npx wrangler tail
```

for diagnostics.

Do not manually trigger collection every day after this.

The purpose of Phase 0 is to remove the laptop and the human from routine collection.

---

# 32. Recommended final Phase-0 architecture

```text
                 Cloudflare Cron
                       │
                       ▼
                runSpyCollection()
                       │
                       ▼
                 Alpaca REST API
                       │
                       ▼
                validate response
                       │
                       ▼
                    normalize
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
          raw JSON          normalized JSON
             │                   │
             └─────────┬─────────┘
                       ▼
                  Cloudflare R2
                       │
                       ▼
                  /latest/SPY
```

Manual recovery/debug path:

```text
POST /collect
      │
COLLECT_TOKEN
      │
      ▼
runSpyCollection()
```

---

# 33. Phase-0 definition of done

Phase 0 is complete when all of these statements are true:

- [ ] Alpaca direct `curl` works.
- [ ] Alpaca credentials are stored as secrets.
- [ ] No Alpaca secret exists in Git.
- [ ] `npm test` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] Local `/health` works.
- [ ] Local `/collect` returns `status: ok`.
- [ ] Local `/collect` reports `source: alpaca`.
- [ ] Local `/latest/SPY` returns valid normalized bars.
- [ ] Deployed Worker can call Alpaca.
- [ ] Deployed `/collect` successfully writes to production R2.
- [ ] Production `/latest/SPY` works.
- [ ] Raw Alpaca JSON exists in production R2.
- [ ] Normalized SPY JSON exists in production R2.
- [ ] A canonical daily observation is safe against duplicate runs.
- [ ] Cloudflare Cron invokes the collection automatically.
- [ ] Two executions for the same market day do not create duplicate logical observations.
- [ ] The Mac can be turned off and collection still occurs.

The final Phase-0 statement should be:

> Every weekday Cloudflare automatically obtains SPY daily data from Alpaca, validates it, stores it in R2, and exposes the latest normalized dataset. The collection mechanism does not depend on my laptop.

---

# 34. Instructions for IBM Bob

Give Bob this implementation constraint before switching to Worker/implementation mode:

```text
Implement 004-alpaca-migration-plan.md strictly as a Phase 0 provider migration.

Important constraints:
- Replace Stooq with Alpaca.
- Keep SPY as the only symbol.
- Preserve the current Tiny Bloomberg normalized DailyBar schema.
- Preserve POST /collect and GET /latest/SPY.
- Preserve the existing R2 binding and normalized R2 paths.
- Store raw Alpaca responses as JSON under raw/alpaca/daily/SPY/.
- Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY only as environment secrets.
- Use native fetch; do not add the Alpaca SDK.
- Use Alpaca historical 1Day bars and feed=iex for Phase 0.
- Add focused tests with mocked Alpaca responses.
- Do not implement multiple symbols, dashboards, queues, databases, AI, streaming, or other architecture changes.
- Do not add Cron until manual deployed Worker → Alpaca → R2 collection has been proven.
- Show me the git diff after implementation and explain each changed file.
```

After Bob finishes, run yourself:

```bash
git status
git diff
npm test
npx tsc --noEmit
```

Then perform the local integration test manually.

---

# 35. Failure rules

## If direct Alpaca curl fails

Do not change code.

Resolve:

```text
credentials / account / endpoint / feed
```

first.

## If local Worker fails but direct Alpaca curl works

Debug:

```text
environment variables
request headers
URL construction
JSON parsing
```

## If local Worker succeeds but Cloudflare deployment fails

Debug:

```text
Cloudflare secrets
deployed Worker logs
Cloudflare outbound request
Alpaca response status
```

Do not replace Alpaca just because configuration is missing.

## If Alpaca returns 403 with `feed=iex`

Inspect the returned Alpaca error and account permissions.

Do not automatically switch to SIP.

## If Alpaca proves unusable from Cloudflare

Stop at Gate C and evaluate another provider.

Do not build Cron around an unreliable provider.

---

# 36. What comes after Phase 0

Only after Phase 0 is stable should Tiny Bloomberg move to Phase 1.

Possible Phase 1 work:

```text
more symbols
incremental historical archive
provider abstraction
collection status metadata
data completeness checks
observability
backfill logic
```

But none of that is required to finish Phase 0.

---

# 37. References

Alpaca historical bars:

https://docs.alpaca.markets/us/reference/stockbarsingle-1

Alpaca market-data authentication:

https://docs.alpaca.markets/us/docs/historical-api

Cloudflare Worker configuration:

https://developers.cloudflare.com/workers/wrangler/configuration/

Cloudflare secrets:

https://developers.cloudflare.com/workers/configuration/secrets/

Cloudflare Cron Triggers:

https://developers.cloudflare.com/workers/configuration/cron-triggers/

Tiny Bloomberg repository:

https://github.com/michalkordyzon/tiny-bloomberg
