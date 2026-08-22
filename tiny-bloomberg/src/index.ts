interface Env {
	MARKET_DATA: R2Bucket;
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

function normalizeStooqDaily(csv: string, collectedAt: string) {
	const lines = csv.trim().split(/\r?\n/);

	if (lines.length < 2) {
		throw new Error('Stooq returned no daily data');
	}

	const header = lines[0].split(',');

	const expectedHeader = ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'];

	if (header.length !== expectedHeader.length || !expectedHeader.every((value, index) => header[index] === value)) {
		throw new Error(`Unexpected Stooq CSV header: ${lines[0]}`);
	}

	const bars: DailyBar[] = lines
		.slice(1)
		.filter(Boolean)
		.map((line) => {
			const [date, open, high, low, close, volume] = line.split(',');

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
			throw new Error(`Invalid Stooq row for date ${bar.date || 'unknown'}`);
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

async function collectSpy(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('Authorization') ?? '';
	if (auth !== `Bearer ${env.COLLECT_TOKEN}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	const stooqResponse = await fetch('https://stooq.com/q/d/l/?s=spy.us&i=d');

	if (!stooqResponse.ok) {
		return Response.json({ status: 'error', message: `Stooq HTTP ${stooqResponse.status}` }, { status: 502 });
	}

	const rawCsv = await stooqResponse.text();

	if (!rawCsv.trim()) {
		return Response.json({ status: 'error', message: 'Stooq returned an empty response' }, { status: 502 });
	}

	const collectedAt = new Date().toISOString();
	const storageTimestamp = collectedAt.replace(/:/g, '-');

	let normalized;

	try {
		normalized = normalizeStooqDaily(rawCsv, collectedAt);
	} catch (error) {
		return Response.json(
			{
				status: 'error',
				message: error instanceof Error ? error.message : 'Failed to parse Stooq data',
			},
			{ status: 502 },
		);
	}

	const rawKey = `raw/stooq/daily/SPY/${storageTimestamp}.csv`;

	await env.MARKET_DATA.put(rawKey, rawCsv, {
		httpMetadata: { contentType: 'text/csv' },
	});

	const normalizedKey = `normalized/daily/SPY/${storageTimestamp}.json`;

	await env.MARKET_DATA.put(normalizedKey, JSON.stringify(normalized), {
		httpMetadata: { contentType: 'application/json' },
	});

	await env.MARKET_DATA.put('normalized/daily/SPY/latest.json', JSON.stringify(normalized), {
		httpMetadata: { contentType: 'application/json' },
	});

	return Response.json({
		status: 'ok',
		symbol: 'SPY',
		source: 'stooq',
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
