interface Env {
	MARKET_DATA: R2Bucket;
	ALPHA_VANTAGE_API_KEY: string;
	COLLECT_TOKEN: string;
}

interface DailyBar {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

function normalizeDaily(raw: Record<string, unknown>, collectedAt: string) {
	const series = raw['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined;
	if (!series) {
		throw new Error('Alpha Vantage returned no daily series');
	}

	const bars: DailyBar[] = Object.entries(series).map(([date, row]) => ({
		date,
		open: Number(row['1. open']),
		high: Number(row['2. high']),
		low: Number(row['3. low']),
		close: Number(row['4. close']),
		volume: Number(row['5. volume']),
	}));

	bars.sort((a, b) => b.date.localeCompare(a.date));

	return {
		schemaVersion: 1,
		symbol: 'SPY',
		assetType: 'ETF',
		currency: 'USD',
		frequency: 'daily',
		source: 'alphavantage',
		collectedAt,
		bars,
	};
}

async function collectSpy(request: Request, env: Env): Promise<Response> {
	// Authenticate
	const auth = request.headers.get('Authorization') ?? '';
	if (auth !== `Bearer ${env.COLLECT_TOKEN}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	// Fetch from Alpha Vantage
	const apiUrl = new URL('https://www.alphavantage.co/query');
	apiUrl.searchParams.set('function', 'TIME_SERIES_DAILY');
	apiUrl.searchParams.set('symbol', 'SPY');
	apiUrl.searchParams.set('outputsize', 'compact');
	apiUrl.searchParams.set('apikey', env.ALPHA_VANTAGE_API_KEY);

	const avResponse = await fetch(apiUrl);
	if (!avResponse.ok) {
		return Response.json({ status: 'error', message: `Alpha Vantage HTTP ${avResponse.status}` }, { status: 502 });
	}

	const raw = (await avResponse.json()) as Record<string, unknown>;

	// Validate — never write error messages as market data
	if (raw['Error Message'] || raw['Note'] || raw['Information']) {
		const msg = (raw['Error Message'] ?? raw['Note'] ?? raw['Information']) as string;
		return Response.json({ status: 'error', message: msg }, { status: 502 });
	}
	if (!raw['Time Series (Daily)']) {
		return Response.json({ status: 'error', message: 'Alpha Vantage returned no daily series' }, { status: 502 });
	}

	// Timestamps
	const collectedAt = new Date().toISOString();
	const storageTimestamp = collectedAt.replace(/:/g, '-');

	// Save raw
	const rawKey = `raw/alphavantage/daily/SPY/${storageTimestamp}.json`;
	await env.MARKET_DATA.put(rawKey, JSON.stringify(raw), {
		httpMetadata: { contentType: 'application/json' },
	});

	// Normalize
	const normalized = normalizeDaily(raw, collectedAt);
	const normalizedKey = `normalized/daily/SPY/${storageTimestamp}.json`;

	// Save normalized snapshot + latest
	await env.MARKET_DATA.put(normalizedKey, JSON.stringify(normalized), {
		httpMetadata: { contentType: 'application/json' },
	});
	await env.MARKET_DATA.put('normalized/daily/SPY/latest.json', JSON.stringify(normalized), {
		httpMetadata: { contentType: 'application/json' },
	});

	return Response.json({
		status: 'ok',
		symbol: 'SPY',
		source: 'alphavantage',
		records: normalized.bars.length,
		latestMarketDate: normalized.bars[0]?.date ?? null,
		rawObject: rawKey,
		normalizedObject: normalizedKey,
		collectedAt,
	});
}

async function getLatest(env: Env): Promise<Response> {
	const object = await env.MARKET_DATA.get('normalized/daily/SPY/latest.json');
	if (!object) {
		return Response.json({ status: 'error', message: 'No data collected yet' }, { status: 404 });
	}
	const text = await object.text();
	return new Response(text, {
		headers: { 'Content-Type': 'application/json' },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ service: 'tiny-bloomberg', status: 'ok' });
		}

		if (url.pathname === '/collect' && request.method === 'POST') {
			return collectSpy(request, env);
		}

		if (url.pathname === '/latest/SPY') {
			return getLatest(env);
		}

		return new Response('Not found', { status: 404 });
	},
};
