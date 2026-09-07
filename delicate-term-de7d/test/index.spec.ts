import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { membershipRowGrantsAccess } from '../src/membership';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('PDF Worker', () => {
	it('GET /health returns ok (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true });
	});

	it('GET /health returns ok (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ok: true });
	});

	it('GET /issues/:slug/pdf without token returns 401', async () => {
		const response = await SELF.fetch('https://example.com/issues/test-slug/pdf');
		expect(response.status).toBe(401);
	});
});

describe('Stripe endpoints', () => {
	const authGated = ['/create-checkout-session', '/cancel-subscription', '/deactivate-account', '/admin/gift-membership'];

	for (const path of authGated) {
		it(`POST ${path} without a token returns 401`, async () => {
			const response = await SELF.fetch(`https://example.com${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			});
			expect(response.status).toBe(401);
		});
	}

	it('POST /webhooks/stripe with a missing/invalid signature returns 400', async () => {
		const response = await SELF.fetch('https://example.com/webhooks/stripe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'evt_test', type: 'ping' }),
		});
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).toMatch(/Webhook Error/);
	});

	it('POST /webhooks/stripe is not behind auth (no 401)', async () => {
		const response = await SELF.fetch('https://example.com/webhooks/stripe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(response.status).not.toBe(401);
	});
});

describe('membershipRowGrantsAccess: gift membership expiry', () => {
	const past = new Date(Date.now() - 86_400_000).toISOString();
	const future = new Date(Date.now() + 86_400_000).toISOString();

	it('denies an expired gift (past current_period_end, no subscription)', () => {
		expect(membershipRowGrantsAccess({ status: 'active', current_period_end: past, stripe_subscription_id: null })).toBe(false);
	});

	it('grants an unexpired gift (future current_period_end, no subscription)', () => {
		expect(membershipRowGrantsAccess({ status: 'active', current_period_end: future, stripe_subscription_id: null })).toBe(true);
	});

	it('grants an open-ended gift (null current_period_end, no subscription)', () => {
		expect(membershipRowGrantsAccess({ status: 'active', current_period_end: null, stripe_subscription_id: null })).toBe(true);
	});

	it('keeps a subscription row status-only, a past current_period_end still grants', () => {
		expect(membershipRowGrantsAccess({ status: 'active', current_period_end: past, stripe_subscription_id: 'sub_123' })).toBe(true);
	});

	it('denies any row whose status is not in the active set', () => {
		expect(membershipRowGrantsAccess({ status: 'canceled', current_period_end: future, stripe_subscription_id: null })).toBe(false);
		expect(membershipRowGrantsAccess({ status: 'incomplete', current_period_end: future, stripe_subscription_id: 'sub_123' })).toBe(false);
	});
});
