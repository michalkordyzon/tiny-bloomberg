# 003 — Migration Plan: Alpha Vantage → Stooq

## Goal

Replace Alpha Vantage with Stooq as the market-data source for Tiny Bloomberg while preserving the existing Cloudflare Worker + R2 architecture.

Target architecture:

```text
POST /collect
     ↓
Cloudflare Worker
     ↓
Stooq daily CSV
     ↓
validate + parse
     ↓
normalize to Tiny Bloomberg schema
     ↓
R2 raw snapshot + normalized snapshot + latest.json
```

The migration should remove the dependency on an external API key and keep the existing public behavior of:

- `POST /collect`
- `GET /latest/SPY`
- R2 normalized data under `normalized/daily/SPY/...`

---

## Current state

Current implementation lives in:

```text
tiny-bloomberg/src/index.ts
```

Current flow:

```text
/collect
  → authenticate with COLLECT_TOKEN
  → call Alpha Vantage TIME_SERIES_DAILY for SPY
  → validate Alpha Vantage JSON
  → normalize JSON
  → save raw Alpha Vantage response to R2
  → save normalized snapshot to R2
  → update normalized/daily/SPY/latest.json
```

Current environment bindings:

```ts
interface Env {
    MARKET_DATA: R2Bucket;
    ALPHA_VANTAGE_API_KEY: string;
    COLLECT_TOKEN: string;
}
```

Current raw storage path:

```text
raw/alphavantage/daily/SPY/<timestamp>.json
```

Current normalized storage paths:

```text
normalized/daily/SPY/<timestamp>.json
normalized/daily/SPY/latest.json
```

---

# Migration principles

The migration should be deliberately small.

Do **not** redesign the Worker, introduce a database, add libraries, or generalize to many symbols yet.

Preserve:

- the `/collect` endpoint
- `COLLECT_TOKEN`
- the `DailyBar` structure
- normalized R2 paths
- `/latest/SPY`
- `schemaVersion: 1`
- existing authentication behavior

Change only:

- data-source request
- raw-data format
- parser
- source metadata
- Alpha Vantage secret/config references

---

# Phase 0 — Create a migration checkpoint

Before changing code:

```bash
git status
git add .
git commit -m "checkpoint before Stooq migration"
```

If the working tree is already clean, no new checkpoint commit is necessary.

Optional branch:

```bash
git checkout -b switch-to-stooq
```

This gives us a trivial rollback path.

---

# Phase 1 — Verify Stooq directly

First test Stooq from the Mac.

```bash
curl "https://stooq.com/q/d/l/?s=spy.us&i=d"
```

Expected structure:

```csv
Date,Open,High,Low,Close,Volume
2026-08-18,....
2026-08-17,....
...
```

Success criteria:

- HTTP request succeeds
- response is CSV
- first line contains the expected columns
- SPY daily rows are returned
- no API key is required

Do not change the Worker until this test works.

---

# Phase 2 — Verify Stooq from Cloudflare

Before rewriting the collector, test Stooq from the Worker environment.

A temporary endpoint can be added:

```ts
async function testStooq(): Promise<Response> {
    const response = await fetch(
        'https://stooq.com/q/d/l/?s=spy.us&i=d'
    );

    const text = await response.text();

    return new Response(text.slice(0, 1000), {
        status: response.status,
        headers: {
            'Content-Type': 'text/plain',
        },
    });
}
```

Temporary route:

```ts
if (url.pathname === '/test-stooq') {
    return testStooq();
}
```

Deploy:

```bash
cd tiny-bloomberg
npx wrangler deploy
```

Test:

```bash
curl https://tiny-bloomberg.michalkordyzon.workers.dev/test-stooq
```

Success criterion:

Stooq CSV is returned from the deployed Cloudflare Worker.

Only after this succeeds should Alpha Vantage code be removed.

Delete `/test-stooq` once the migration is complete.

---

# Phase 3 — Remove Alpha Vantage from `Env`

Current:

```ts
interface Env {
    MARKET_DATA: R2Bucket;
    ALPHA_VANTAGE_API_KEY: string;
    COLLECT_TOKEN: string;
}
```

Change to:

```ts
interface Env {
    MARKET_DATA: R2Bucket;
    COLLECT_TOKEN: string;
}
```

Reason:

Stooq requires no API key.

---

# Phase 4 — Keep the existing normalized schema

Keep the current `DailyBar` interface:

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

The normalized Tiny Bloomberg document should remain structurally compatible:

```json
{
  "schemaVersion": 1,
  "symbol": "SPY",
  "assetType": "ETF",
  "currency": "USD",
  "frequency": "daily",
  "source": "stooq",
  "collectedAt": "...",
  "bars": []
}
```

This is important because `/latest/SPY` and future consumers should not care which upstream provider supplied the data.

Only this field changes:

```text
source: alphavantage
```

to:

```text
source: stooq
```

---

# Phase 5 — Replace Alpha Vantage normalization with CSV parsing

Alpha Vantage currently returns nested JSON.

Stooq returns CSV, so replace the current `normalizeDaily(raw, collectedAt)` logic.

Recommended parser:

```ts
function normalizeStooqDaily(csv: string, collectedAt: string) {
    const lines = csv.trim().split(/\r?\n/);

    if (lines.length < 2) {
        throw new Error('Stooq returned no daily data');
    }

    const header = lines[0].split(',');

    const expectedHeader = [
        'Date',
        'Open',
        'High',
        'Low',
        'Close',
        'Volume',
    ];

    if (
        header.length !== expectedHeader.length ||
        !expectedHeader.every((value, index) => header[index] === value)
    ) {
        throw new Error(
            `Unexpected Stooq CSV header: ${lines[0]}`
        );
    }

    const bars: DailyBar[] = lines
        .slice(1)
        .filter(Boolean)
        .map((line) => {
            const [
                date,
                open,
                high,
                low,
                close,
                volume,
            ] = line.split(',');

            return {
                date,
                open: Number(open),
                high: Number(high),
                low: Number(low),
                close: Number(close),
                volume: Number(volume),
            };
        });

    for (const bar of bars) {
        if (
            !bar.date ||
            !Number.isFinite(bar.open) ||
            !Number.isFinite(bar.high) ||
            !Number.isFinite(bar.low) ||
            !Number.isFinite(bar.close) ||
            !Number.isFinite(bar.volume)
        ) {
            throw new Error(
                `Invalid Stooq row for date ${bar.date || 'unknown'}`
            );
        }
    }

    bars.sort((a, b) => b.date.localeCompare(a.date));

    return {
        schemaVersion: 1,
        symbol: 'SPY',
        assetType: 'ETF',
        currency: 'USD',
        frequency: 'daily',
        source: 'stooq',
        collectedAt,
        bars,
    };
}
```

Important behavior:

- blank lines are ignored
- malformed headers fail loudly
- invalid numeric values are rejected
- data is sorted newest-first
- output schema remains unchanged

No CSV dependency is needed for this simple fixed six-column dataset.

---

# Phase 6 — Replace the Alpha Vantage fetch

Remove:

```ts
const apiUrl = new URL('https://www.alphavantage.co/query');

apiUrl.searchParams.set('function', 'TIME_SERIES_DAILY');
apiUrl.searchParams.set('symbol', 'SPY');
apiUrl.searchParams.set('outputsize', 'compact');
apiUrl.searchParams.set('apikey', env.ALPHA_VANTAGE_API_KEY);

const avResponse = await fetch(apiUrl);
```

Replace with:

```ts
const stooqUrl =
    'https://stooq.com/q/d/l/?s=spy.us&i=d';

const stooqResponse = await fetch(stooqUrl);
```

Then validate the HTTP response:

```ts
if (!stooqResponse.ok) {
    return Response.json(
        {
            status: 'error',
            message: `Stooq HTTP ${stooqResponse.status}`,
        },
        { status: 502 },
    );
}
```

Read the response as text:

```ts
const rawCsv = await stooqResponse.text();
```

---

# Phase 7 — Validate Stooq before writing anything to R2

Never write a failed provider response to the market-data dataset.

Minimum checks:

```ts
if (!rawCsv.trim()) {
    return Response.json(
        {
            status: 'error',
            message: 'Stooq returned an empty response',
        },
        { status: 502 },
    );
}
```

Then normalize inside a protected block:

```ts
let normalized;

try {
    normalized = normalizeStooqDaily(
        rawCsv,
        collectedAt,
    );
} catch (error) {
    return Response.json(
        {
            status: 'error',
            message:
                error instanceof Error
                    ? error.message
                    : 'Failed to parse Stooq data',
        },
        { status: 502 },
    );
}
```

Only write to R2 after parsing and validation succeeds.

---

# Phase 8 — Change raw R2 storage

Current Alpha Vantage path:

```text
raw/alphavantage/daily/SPY/<timestamp>.json
```

New Stooq path:

```text
raw/stooq/daily/SPY/<timestamp>.csv
```

Implementation:

```ts
const rawKey =
    `raw/stooq/daily/SPY/${storageTimestamp}.csv`;

await env.MARKET_DATA.put(rawKey, rawCsv, {
    httpMetadata: {
        contentType: 'text/csv',
    },
});
```

Keep previous Alpha Vantage files.

Do **not** delete:

```text
raw/alphavantage/...
```

Historical raw data should remain immutable.

---

# Phase 9 — Keep normalized R2 paths unchanged

Continue using:

```text
normalized/daily/SPY/<timestamp>.json
normalized/daily/SPY/latest.json
```

Implementation stays essentially unchanged:

```ts
const normalizedKey =
    `normalized/daily/SPY/${storageTimestamp}.json`;

await env.MARKET_DATA.put(
    normalizedKey,
    JSON.stringify(normalized),
    {
        httpMetadata: {
            contentType: 'application/json',
        },
    },
);

await env.MARKET_DATA.put(
    'normalized/daily/SPY/latest.json',
    JSON.stringify(normalized),
    {
        httpMetadata: {
            contentType: 'application/json',
        },
    },
);
```

This is intentional.

Consumers should access normalized data independently of the provider.

---

# Phase 10 — Update `/collect` response

Current response identifies Alpha Vantage.

Change it to:

```ts
return Response.json({
    status: 'ok',
    symbol: 'SPY',
    source: 'stooq',
    records: normalized.bars.length,
    latestMarketDate:
        normalized.bars[0]?.date ?? null,
    rawObject: rawKey,
    normalizedObject: normalizedKey,
    collectedAt,
});
```

Expected result:

```json
{
  "status": "ok",
  "symbol": "SPY",
  "source": "stooq",
  "records": 5000,
  "latestMarketDate": "2026-08-18",
  "rawObject": "raw/stooq/daily/SPY/...",
  "normalizedObject": "normalized/daily/SPY/...",
  "collectedAt": "..."
}
```

The exact number of records is not part of the contract.

---

# Phase 11 — Resulting `collectSpy()` shape

The final function should follow this sequence:

```text
1. authenticate request
2. fetch Stooq CSV
3. reject non-2xx HTTP response
4. reject empty body
5. generate timestamps
6. parse and validate CSV
7. save raw CSV to R2
8. save normalized snapshot to R2
9. update latest.json
10. return success response
```

Conceptual implementation:

```ts
async function collectSpy(
    request: Request,
    env: Env,
): Promise<Response> {
    const auth =
        request.headers.get('Authorization') ?? '';

    if (auth !== `Bearer ${env.COLLECT_TOKEN}`) {
        return new Response(
            'Unauthorized',
            { status: 401 },
        );
    }

    const stooqUrl =
        'https://stooq.com/q/d/l/?s=spy.us&i=d';

    const stooqResponse =
        await fetch(stooqUrl);

    if (!stooqResponse.ok) {
        return Response.json(
            {
                status: 'error',
                message:
                    `Stooq HTTP ${stooqResponse.status}`,
            },
            { status: 502 },
        );
    }

    const rawCsv =
        await stooqResponse.text();

    if (!rawCsv.trim()) {
        return Response.json(
            {
                status: 'error',
                message:
                    'Stooq returned an empty response',
            },
            { status: 502 },
        );
    }

    const collectedAt =
        new Date().toISOString();

    const storageTimestamp =
        collectedAt.replace(/:/g, '-');

    let normalized;

    try {
        normalized =
            normalizeStooqDaily(
                rawCsv,
                collectedAt,
            );
    } catch (error) {
        return Response.json(
            {
                status: 'error',
                message:
                    error instanceof Error
                        ? error.message
                        : 'Failed to parse Stooq data',
            },
            { status: 502 },
        );
    }

    const rawKey =
        `raw/stooq/daily/SPY/${storageTimestamp}.csv`;

    await env.MARKET_DATA.put(
        rawKey,
        rawCsv,
        {
            httpMetadata: {
                contentType: 'text/csv',
            },
        },
    );

    const normalizedKey =
        `normalized/daily/SPY/${storageTimestamp}.json`;

    await env.MARKET_DATA.put(
        normalizedKey,
        JSON.stringify(normalized),
        {
            httpMetadata: {
                contentType: 'application/json',
            },
        },
    );

    await env.MARKET_DATA.put(
        'normalized/daily/SPY/latest.json',
        JSON.stringify(normalized),
        {
            httpMetadata: {
                contentType: 'application/json',
            },
        },
    );

    return Response.json({
        status: 'ok',
        symbol: 'SPY',
        source: 'stooq',
        records: normalized.bars.length,
        latestMarketDate:
            normalized.bars[0]?.date ?? null,
        rawObject: rawKey,
        normalizedObject: normalizedKey,
        collectedAt,
    });
}
```

---

# Phase 12 — Update Wrangler documentation

Current `wrangler.jsonc` comments mention:

```text
ALPHA_VANTAGE_API_KEY
COLLECT_TOKEN
```

Update comments so only the remaining secret is documented:

```text
// Secret COLLECT_TOKEN is set via:
// npx wrangler secret put COLLECT_TOKEN
//
// For local dev, values are in .dev.vars
// Never commit .dev.vars.
```

No new Stooq secret is needed.

---

# Phase 13 — Remove Alpha Vantage secret

Only after Stooq works successfully in production:

```bash
cd tiny-bloomberg
npx wrangler secret delete ALPHA_VANTAGE_API_KEY
```

This is cleanup, not a prerequisite for deployment.

Do not delete the secret before the Stooq version has been tested, because retaining it temporarily makes rollback easier.

---

# Phase 14 — Local test

Start local development:

```bash
cd tiny-bloomberg
npx wrangler dev
```

Call:

```bash
curl \
  -X POST \
  http://localhost:8787/collect \
  -H "Authorization: Bearer YOUR_COLLECT_TOKEN"
```

Expected:

```json
{
  "status": "ok",
  "symbol": "SPY",
  "source": "stooq"
}
```

Then:

```bash
curl http://localhost:8787/latest/SPY
```

Validate:

- `source` is `stooq`
- `symbol` is `SPY`
- `bars` exists
- bars are not empty
- newest bar is first
- OHLC values are numbers
- volume is numeric

---

# Phase 15 — Deployment

Deploy:

```bash
cd tiny-bloomberg
npx wrangler deploy
```

Do not change routes or Worker name.

---

# Phase 16 — Production test

Run the existing production collector:

```bash
curl \
  -X POST \
  https://tiny-bloomberg.michalkordyzon.workers.dev/collect \
  -H "Authorization: Bearer YOUR_COLLECT_TOKEN"
```

Expected:

```json
{
  "status": "ok",
  "symbol": "SPY",
  "source": "stooq"
}
```

Then verify:

```bash
curl \
  https://tiny-bloomberg.michalkordyzon.workers.dev/latest/SPY
```

Expected normalized response:

```json
{
  "schemaVersion": 1,
  "symbol": "SPY",
  "assetType": "ETF",
  "currency": "USD",
  "frequency": "daily",
  "source": "stooq",
  "collectedAt": "...",
  "bars": []
}
```

---

# Phase 17 — Verify R2 objects

Confirm these objects exist:

```text
raw/stooq/daily/SPY/<timestamp>.csv
normalized/daily/SPY/<timestamp>.json
normalized/daily/SPY/latest.json
```

Confirm `latest.json` contains:

```json
"source": "stooq"
```

Also confirm the raw object is genuine CSV and not an HTML/error page.

---

# Phase 18 — Negative tests

The collector should fail safely.

## Missing token

```bash
curl \
  -X POST \
  https://tiny-bloomberg.michalkordyzon.workers.dev/collect
```

Expected:

```text
401 Unauthorized
```

## Wrong token

Expected:

```text
401 Unauthorized
```

## Provider failure

If Stooq becomes unavailable:

- Worker should return `502`
- no malformed data should overwrite `latest.json`
- previously valid `latest.json` should remain intact

This is a key reliability property.

---

# Phase 19 — Remove temporary diagnostic routes

Delete any temporary routes added during investigation:

```text
/debug-ip
/test-stooq
```

They are no longer needed after migration validation.

The production Worker should expose only the intended endpoints.

---

# Phase 20 — Commit

Suggested commit:

```bash
git add tiny-bloomberg/src/index.ts tiny-bloomberg/wrangler.jsonc
git commit -m "replace Alpha Vantage with Stooq market data"
git push
```

If this plan is committed too:

```bash
git add 003-stooq-migration-plan.md
git commit -m "document Stooq migration plan"
git push
```

Or include everything in a single migration commit.

---

# Definition of done

The migration is complete when all of the following are true:

- [ ] direct Stooq SPY CSV request works
- [ ] Stooq request works from Cloudflare Worker
- [ ] Alpha Vantage fetch code is removed
- [ ] `ALPHA_VANTAGE_API_KEY` is removed from `Env`
- [ ] Stooq CSV is validated before R2 writes
- [ ] raw Stooq CSV is stored in R2
- [ ] normalized JSON is stored in R2
- [ ] `normalized/daily/SPY/latest.json` is updated
- [ ] normalized `source` equals `stooq`
- [ ] `/collect` returns `status: ok`
- [ ] `/latest/SPY` returns Stooq-backed normalized data
- [ ] unauthorized `/collect` still returns 401
- [ ] previous Alpha Vantage raw snapshots remain untouched
- [ ] temporary diagnostic endpoints are removed
- [ ] Alpha Vantage Wrangler secret is deleted after successful production validation
- [ ] changes are committed to Git

---

# Explicit non-goals

Do not do these as part of this migration:

- add more symbols
- add cron scheduling
- add a database
- introduce queues
- add an abstraction framework for providers
- install a CSV package
- redesign R2 paths
- change normalized schema version
- rewrite `/latest/SPY`

Those can come later.

The objective of this migration is simply:

```text
SPY → Stooq → Cloudflare Worker → R2
```

and to make that path boring and reliable.

---

# Recommended implementation order

Use this exact sequence:

```text
1. test Stooq from Mac
2. test Stooq from Worker
3. create normalizeStooqDaily()
4. replace Alpha Vantage fetch
5. change raw R2 storage to CSV
6. keep normalized storage unchanged
7. test locally
8. deploy
9. call production /collect
10. verify /latest/SPY
11. verify R2
12. remove temporary diagnostics
13. remove Alpha Vantage secret
14. commit
```

This sequence minimizes risk and makes every step independently testable.
