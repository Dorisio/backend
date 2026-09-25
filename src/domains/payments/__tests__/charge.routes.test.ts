import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerChargeRoutes } from '../charge.routes';
import { FakePrisma } from './fake-prisma';
import { FakePaymentProvider } from '../../../lib/payments/provider';
import { generateAccessToken } from '../../../utils/jwt';
import { AppError } from '../../../utils/errors';
import { applyJsonSerializer } from '../../../config/serialization';

function tokenFor(userId: string): string {
  return generateAccessToken({ userId, email: `${userId}@test.com`, role: 'fan' });
}

function buildApp(prisma: FakePrisma, provider: FakePaymentProvider): FastifyInstance {
  const app = Fastify({ logger: false });
  applyJsonSerializer(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ message: error.message });
  });
  registerChargeRoutes(app, prisma as never, provider);
  return app;
}

describe('payment routes', () => {
  let app: FastifyInstance;
  let prisma: FakePrisma;
  let provider: FakePaymentProvider;

  beforeEach(async () => {
    prisma = new FakePrisma();
    provider = new FakePaymentProvider({ status: 'succeeded' });
    app = buildApp(prisma, provider);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication to create a payment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      payload: { amount: 10, method: 'card' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a payment for an authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${tokenFor('user-1')}`, 'idempotency-key': 'route-key-1' },
      payload: { amount: 10, currency: 'USD', method: 'card' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('succeeded');
    expect(body.data.clientSecret).toBeDefined();
  });

  it('validates the payment body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${tokenFor('user-1')}` },
      payload: { amount: -5, method: 'card' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('lists the caller payments', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { ...auth },
      payload: { amount: 10, method: 'card' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/payments', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.total).toBe(1);
  });

  it('returns a single payment and forbids other users', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: auth,
      payload: { amount: 10, method: 'card' },
    });
    const id = created.json().data.id;

    const own = await app.inject({ method: 'GET', url: `/api/v1/payments/${id}`, headers: auth });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${id}`,
      headers: { authorization: `Bearer ${tokenFor('user-2')}` },
    });
    expect(other.statusCode).toBe(403);
  });

  it('refunds a payment', async () => {
    const auth = { authorization: `Bearer ${tokenFor('user-1')}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: auth,
      payload: { amount: 40, method: 'card' },
    });
    const id = created.json().data.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${id}/refund`,
      headers: { ...auth, 'idempotency-key': 'refund-route-1' },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.amount).toBe(40);
  });

  it('accepts a correctly signed webhook', async () => {
    const payload = JSON.stringify({
      id: 'evt_route_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_unknown' } },
    });
    const signature = provider.sign(payload);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/fake',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('rejects an unsigned webhook', async () => {
    const payload = JSON.stringify({ id: 'evt_route_2', type: 'payment_intent.succeeded', data: { object: { id: 'x' } } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/fake',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bogus' },
      payload,
    });

    expect(res.statusCode).toBe(401);
  });
});
