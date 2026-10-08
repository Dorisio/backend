import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { RequestMetricsStore } from '../../lib/request-metrics';
import {
  registerRequestMetrics,
  resetRequestMetricsHook,
  resolveRoutePattern,
} from '../requestMetrics';

describe('registerRequestMetrics', () => {
  let app: FastifyInstance;
  let store: RequestMetricsStore;

  beforeEach(async () => {
    resetRequestMetricsHook();
    store = new RequestMetricsStore();
    app = Fastify();
    registerRequestMetrics(app, { store });
    app.get('/api/v1/things/:id', async () => ({ ok: true }));
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records a request under its route pattern, not the concrete URL', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/things/abc?expand=1' });

    const snapshot = store.snapshot(60_000);
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.byRoute).toHaveLength(1);
    expect(snapshot.byRoute[0]).toMatchObject({
      route: '/api/v1/things/:id',
      method: 'GET',
      requests: 1,
      errors: 0,
    });
    expect(snapshot.byRoute[0].p50).toBeGreaterThanOrEqual(0);
  });

  it('excludes health and metrics endpoints from the aggregate', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/api/v1/things/abc' });

    const snapshot = store.snapshot(60_000);
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.byRoute[0].route).toBe('/api/v1/things/:id');
  });

  it('counts 5xx responses as errors', async () => {
    app.get('/api/v1/boom', async (_request, reply) => {
      reply.code(503).send({ error: 'unavailable' });
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/v1/boom' });

    const snapshot = store.snapshot(60_000);
    const boom = snapshot.byRoute.find((route) => route.route === '/api/v1/boom');
    expect(boom).toMatchObject({ requests: 1, errors: 1, errorRate: 1 });
  });

  it('only installs one hook, even if registration runs twice', async () => {
    registerRequestMetrics(app, { store });
    await app.inject({ method: 'GET', url: '/api/v1/things/abc' });
    expect(store.snapshot(60_000).totals.requests).toBe(1);
  });
});

describe('resolveRoutePattern', () => {
  it('prefers the registered route pattern', () => {
    expect(
      resolveRoutePattern({ routeOptions: { url: '/api/v1/things/:id' }, url: '/api/v1/things/1' } as any)
    ).toBe('/api/v1/things/:id');
  });

  it('falls back to the path without the query string for unmatched routes', () => {
    expect(resolveRoutePattern({ url: '/api/v1/nope?x=1' } as any)).toBe('/api/v1/nope');
  });
});
