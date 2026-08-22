import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('tiny-bloomberg worker', () => {
	it('GET /health returns ok (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ service: 'tiny-bloomberg', status: 'ok' });
	});

	it('GET /health returns ok (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ service: 'tiny-bloomberg', status: 'ok' });
	});

	it('unknown route returns 404', async () => {
		const request = new IncomingRequest('http://example.com/unknown');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('POST /collect without token returns 401', async () => {
		const request = new IncomingRequest('http://example.com/collect', { method: 'POST' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('GET /latest/SPY returns 404 when no data collected', async () => {
		const request = new IncomingRequest('http://example.com/latest/SPY');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});
});
