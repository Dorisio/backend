import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { FakeTierPrisma, asPrisma } from './fake-tier-prisma';
import { createCreatorTierRuntime } from '../tier.runtime';
import { registerCreatorTierRoutes } from '../tier.routes';
import { CreatorTierLimiter } from '../../../lib/creator-tier-limits';

// authMiddleware is intercepted so the tests control request.user without JWTs.
const authMiddlewareMock = vi.fn();
vi.mock('../../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

function setUser(userId = 'user_1') {
  authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
    request.user = { userId, email: 'creator@example.com', role: 'user' };
  });
}

interface Harness {
  app: FastifyInstance;
  fake: FakeTierPrisma;
  limiter: CreatorTierLimiter;
  close: () => Promise<void>;
}

function buildHarness(now?: () => number): Harness {
  const fake = new FakeTierPrisma();
  const app = Fastify({ logger: false });
  const limiter = new CreatorTierLimiter({ now });
  const runtime = createCreatorTierRuntime(asPrisma(fake), {
    limiter,
    now,
    autoFlushUsage: false,
    autoPrune: false,
  });
  registerCreatorTierRoutes(app, asPrisma(fake), { runtime });

  return { app, fake, limiter, close: () => runtime.close() };
}

describe('creator tier routes', () => {
  beforeEach(() => {
    authMiddlewareMock.mockReset();
    setUser();
  });

  it('publishes the plan catalogue without authentication', async () => {
    const { app, close } = buildHarness();

    const response = await app.inject({ method: 'GET', url: '/api/v1/creators/tier/plans' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.tiers.map((plan: { tier: string }) => plan.tier)).toEqual([
      'free',
      'pro',
      'enterprise',
    ]);
    // Prices are exposed both in cents (exact) and in currency units (display).
    const pro = body.data.tiers.find((plan: { tier: string }) => plan.tier === 'pro');
    expect(pro.priceMonthlyCents).toBeGreaterThan(0);
    expect(pro.priceMonthly).toBe(pro.priceMonthlyCents / 100);

    await close();
  });

  it('creates the free subscription on first read and reports the entitled tier', async () => {
    const { app, fake, close } = buildHarness();
    fake.seedCreator({ userId: 'user_1' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.tier).toBe('free');
    expect(body.data.subscribedTier).toBe('free');
    expect(body.data.status).toBe('active');
    // The default subscription is persisted so later reads are stable.
    expect(fake.subscriptions).toHaveLength(1);
    expect(fake.subscriptions[0].creatorId).toBe(fake.creators[0].id);
    expect(response.headers['x-creator-tier']).toBe('free');

    await close();
  });

  it('rejects a caller with no creator profile', async () => {
    const { app, close } = buildHarness();

    const response = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier' });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/creator profile/i);

    await close();
  });

  it('starts a trial on the first upgrade and shows the paid tier immediately', async () => {
    const { app, fake, close } = buildHarness();
    fake.seedCreator({ userId: 'user_1' });

    // Prime the resolver cache with the free tier so the assertions below prove
    // a tier change invalidates it instead of waiting for the TTL.
    const before = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier' });
    expect(before.json().data.tier).toBe('free');

    const upgrade = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/upgrade',
      payload: { tier: 'pro' },
    });

    expect(upgrade.statusCode).toBe(200);
    const upgradeBody = upgrade.json();
    expect(upgradeBody.data.paymentRequired).toBe(false);
    expect(upgradeBody.data.invoice).toBeNull();
    expect(upgradeBody.data.subscription.status).toBe('trialing');
    expect(upgradeBody.data.subscription.tier).toBe('pro');
    expect(upgradeBody.data.subscription.trialDaysRemaining).toBeGreaterThan(0);

    // The cached tier must not survive the write: the next read is already pro.
    const read = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier' });
    expect(read.json().data.tier).toBe('pro');
    expect(read.json().data.status).toBe('trialing');

    expect(fake.invoices).toHaveLength(0);

    await close();
  });

  it('invoices a paid upgrade and only activates once the provider settles it', async () => {
    const fake = new FakeTierPrisma();
    const creator = fake.seedCreator({ userId: 'user_1' });
    const app = Fastify({ logger: false });
    const runtime = createCreatorTierRuntime(asPrisma(fake), { autoFlushUsage: false, autoPrune: false });
    registerCreatorTierRoutes(app, asPrisma(fake), { runtime });

    const upgrade = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/upgrade',
      payload: { tier: 'pro', startTrial: false },
    });

    expect(upgrade.statusCode).toBe(202);
    const body = upgrade.json();
    expect(body.data.paymentRequired).toBe(true);
    expect(body.data.invoice.status).toBe('open');
    expect(body.data.subscription.tier).toBe('free');
    expect(fake.invoices).toHaveLength(1);

    const settled = await runtime.service.markInvoicePaid(creator.id, fake.invoices[0].id);
    expect(settled.subscription.tier).toBe('pro');
    expect(settled.subscription.status).toBe('active');
    expect(fake.invoices[0].status).toBe('paid');

    const read = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier' });
    expect(read.json().data.tier).toBe('pro');

    await runtime.close();
  });

  it('throttles creator reads with the tier budget and returns rate-limit headers', async () => {
    let nowMs = Date.UTC(2026, 8, 27, 12, 0, 0);
    const { app, fake, limiter, close } = buildHarness(() => nowMs);
    const creator = fake.seedCreator({ userId: 'user_1' });

    const first = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/invoices' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-creator-tier-day-limit']).toBe('5000');
    expect(Number(first.headers['x-ratelimit-remaining'])).toBe(59);

    // Spend the whole free-plan minute budget, then the next request is refused.
    limiter.consume(creator.id, 'free', 59);
    const throttled = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/invoices' });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    expect(throttled.json().message).toMatch(/per minute/);

    // A minute later the window has rolled over.
    nowMs += 61_000;
    const recovered = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/invoices' });
    expect(recovered.statusCode).toBe(200);

    await close();
  });

  it('reports month-to-date usage against the plan limits', async () => {
    const { app, fake, close } = buildHarness();
    const creator = fake.seedCreator({ userId: 'user_1' });

    await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/usage' });
    // The usage summary is served from the same counters the middleware feeds.
    await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/invoices' });

    const response = await app.inject({ method: 'GET', url: '/api/v1/creators/me/tier/usage' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.currentTier).toBe('free');
    expect(body.data.limits.apiRequestsPerMinute).toBe(60);
    expect(body.data.rateLimit.allowed).toBe(true);
    // The invoice read spent one API request of the tier budget.
    expect(body.data.apiRequests).toBe(1);
    expect(body.data.exports).toBe(0);
    expect(creator.id).toBe(fake.creators[0].id);

    await close();
  });

  it('schedules a downgrade and can resume it before the period ends', async () => {
    const { app, fake, close } = buildHarness();
    fake.seedCreator({ userId: 'user_1' });

    await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/upgrade',
      payload: { tier: 'enterprise' },
    });

    const downgrade = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/downgrade',
      payload: { tier: 'pro' },
    });
    expect(downgrade.statusCode).toBe(200);
    expect(downgrade.json().data.subscription.nextTier).toBe('pro');
    // Deferred: the paid tier stays until the period ends.
    expect(downgrade.json().data.subscription.tier).toBe('enterprise');

    const cancel = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/cancel',
      payload: {},
    });
    expect(cancel.json().data.subscription.cancelAtPeriodEnd).toBe(true);

    const resume = await app.inject({ method: 'POST', url: '/api/v1/creators/me/tier/resume' });
    expect(resume.json().data.subscription.cancelAtPeriodEnd).toBe(false);
    expect(resume.json().data.subscription.nextTier).toBeNull();

    const conflicts = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/upgrade',
      payload: { tier: 'pro' },
    });
    expect(conflicts.statusCode).toBe(409);

    await close();
  });

  it('rejects an unknown tier with a validation error', async () => {
    const { app, fake, close } = buildHarness();
    fake.seedCreator({ userId: 'user_1' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/me/tier/upgrade',
      payload: { tier: 'platinum' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/invalid request body/i);

    await close();
  });
});
