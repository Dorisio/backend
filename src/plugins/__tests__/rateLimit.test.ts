import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { FastifyInstance, FastifyServerOptions, RouteOptions } from 'fastify';
import jwt from 'jsonwebtoken';
import { classifyRoute, registerRateLimiting, RateLimitingOptions } from '../rateLimit';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { globalErrorHandler } from '../../middleware/error-handler';
import { config } from '../../config/env';
import {
  RATE_LIMIT_EXEMPTIONS,
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_RULES,
  RateLimitClass,
  RateLimitPolicy,
  parseTrustProxy,
} from '../../config/rate-limit';

// Small, distinct limits so each class is distinguishable in a test.
const POLICIES: Record<RateLimitClass, RateLimitPolicy> = {
  public: { max: 3, timeWindowMs: 60_000 },
  authenticated: { max: 5, timeWindowMs: 60_000 },
  sensitive: { max: 2, timeWindowMs: 60_000 },
};

const token = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@example.com`, role: 'user' }, config.JWT_SECRET);

const bearer = (userId: string) => ({ authorization: `Bearer ${token(userId)}` });

let app: FastifyInstance;

async function buildApp(
  options: Partial<RateLimitingOptions> = {},
  serverOptions: FastifyServerOptions = {}
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false, ...serverOptions });
  instance.setErrorHandler(globalErrorHandler);

  await registerRateLimiting(instance, {
    enabled: true,
    store: 'memory',
    policies: POLICIES,
    rules: [{ method: 'POST', url: '/auth/login', class: 'sensitive' }],
    exemptions: [{ method: 'GET', url: '/health' }],
    ...options,
  });

  const ok = async () => ({ ok: true });
  instance.get('/health', ok);
  instance.get('/public', ok);
  instance.get('/other-public', ok);
  instance.get('/private', { preHandler: authMiddleware }, ok);
  instance.post('/auth/login', ok);

  await instance.ready();
  return instance;
}

async function hit(
  url: string,
  times: number,
  opts: { method?: 'GET' | 'POST'; headers?: Record<string, string>; remoteAddress?: string } = {}
) {
  const responses = [];
  for (let i = 0; i < times; i++) {
    responses.push(
      await app.inject({
        method: opts.method ?? 'GET',
        url,
        headers: opts.headers,
        remoteAddress: opts.remoteAddress,
      })
    );
  }
  return responses;
}

afterEach(async () => {
  await app?.close();
});

describe('rate limiting middleware', () => {
  it('lets requests within the limit through with rate-limit headers', async () => {
    app = await buildApp();
    const responses = await hit('/public', 3);

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.headers['x-ratelimit-remaining'])).toEqual(['2', '1', '0']);
    for (const res of responses) {
      expect(res.headers['x-ratelimit-limit']).toBe('3');
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
      expect(res.json()).toEqual({ ok: true });
    }
  });

  it('returns 429 with rate-limit metadata once the limit is exceeded', async () => {
    app = await buildApp();
    await hit('/public', 3);
    const [blocked] = await hit('/public', 1);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    const reset = Number(blocked.headers['x-ratelimit-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(60);
    expect(Number(blocked.headers['retry-after'])).toBe(reset);

    const body = blocked.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.error.details).toMatchObject({
      policy: 'public',
      limit: 3,
      windowMs: 60_000,
      retryAfterSeconds: reset,
    });
  });

  it('localizes the 429 message through the global error handler', async () => {
    app = await buildApp();
    await hit('/public', 3);
    const [blocked] = await hit('/public', 1, { headers: { 'accept-language': 'es' } });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.message).toBe(
      'Demasiadas solicitudes, inténtalo de nuevo más tarde'
    );
  });

  it('allows requests again once the window has elapsed', async () => {
    app = await buildApp({
      policies: { ...POLICIES, public: { max: 1, timeWindowMs: 200 } },
    });

    expect((await hit('/public', 2)).map((r) => r.statusCode)).toEqual([200, 429]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await hit('/public', 1))[0].statusCode).toBe(200);
  });

  it('never rate-limits exempt routes, even under heavy load', async () => {
    app = await buildApp();
    const responses = await hit('/health', 500);

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // Bypassed entirely: no counter, so no rate-limit headers at all.
    for (const res of responses) {
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    }

    // The auto-generated HEAD route for an exempt GET is exempt too.
    const head = await app.inject({ method: 'HEAD', url: '/health' });
    expect(head.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('keeps exempt routes available while the same client is limited elsewhere', async () => {
    app = await buildApp();
    await hit('/public', 4);

    const [health] = await hit('/health', 1);
    expect(health.statusCode).toBe(200);
  });

  it('enforces a distinct limit for each route class', async () => {
    app = await buildApp();
    const user = bearer('user-1');

    const publicRes = await hit('/public', 4);
    const privateRes = await hit('/private', 6, { headers: user });
    const sensitiveRes = await hit('/auth/login', 3, { method: 'POST' });

    expect(publicRes.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
    expect(privateRes.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 429]);
    expect(sensitiveRes.map((r) => r.statusCode)).toEqual([200, 200, 429]);

    expect(publicRes[0].headers['x-ratelimit-limit']).toBe('3');
    expect(privateRes[0].headers['x-ratelimit-limit']).toBe('5');
    expect(sensitiveRes[0].headers['x-ratelimit-limit']).toBe('2');

    expect(publicRes[3].json().error.details.policy).toBe('public');
    expect(privateRes[5].json().error.details.policy).toBe('authenticated');
    expect(sensitiveRes[2].json().error.details.policy).toBe('sensitive');
  });

  it('does not share one counter across routes', async () => {
    app = await buildApp();
    await hit('/auth/login', 3, { method: 'POST' });

    // Exhausting the sensitive route leaves public routes untouched, and two
    // routes of the same class keep separate counters.
    await hit('/public', 3);
    const [other] = await hit('/other-public', 1);
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('counts authenticated requests per user, not per IP', async () => {
    app = await buildApp();
    const alice = await hit('/private', 6, { headers: bearer('alice') });
    const bob = await hit('/private', 1, { headers: bearer('bob') });

    expect(alice[5].statusCode).toBe(429);
    // Same IP as alice, but a different user: separate bucket.
    expect(bob[0].statusCode).toBe(200);
    expect(bob[0].headers['x-ratelimit-remaining']).toBe('4');
  });

  it('follows the user across IPs', async () => {
    app = await buildApp();
    await hit('/public', 3, { headers: bearer('carol'), remoteAddress: '10.0.0.1' });
    const [fromNewIp] = await hit('/public', 1, {
      headers: bearer('carol'),
      remoteAddress: '10.0.0.2',
    });
    expect(fromNewIp.statusCode).toBe(429);
  });

  it('falls back to the IP when the token is invalid', async () => {
    app = await buildApp();
    const forged = jwt.sign({ userId: 'victim' }, 'not-the-secret');
    await hit('/public', 3, { headers: { authorization: `Bearer ${forged}` } });

    // A forged token cannot claim a user bucket; it shares the IP bucket.
    const [anonymous] = await hit('/public', 1);
    expect(anonymous.statusCode).toBe(429);
    const [victim] = await hit('/public', 1, { headers: bearer('victim') });
    expect(victim.statusCode).toBe(200);
  });

  it('rejects routes that configure their own limit inline', async () => {
    app = Fastify({ logger: false });
    await registerRateLimiting(app, { enabled: true, store: 'memory', policies: POLICIES });

    expect(() =>
      app.get('/inline', { config: { rateLimit: { max: 1 } } }, async () => ({}))
    ).toThrow(/assigned centrally/);
  });

  it('attaches nothing when disabled', async () => {
    app = await buildApp({ enabled: false });
    const responses = await hit('/public', 10);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses[0].headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('client IP behind a reverse proxy', () => {
  const PROXY = '10.0.0.10';

  it('buckets clients by the forwarded address when the proxy is trusted', async () => {
    app = await buildApp({}, { trustProxy: PROXY });

    const a = await hit('/public', 4, {
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const [b] = await hit('/public', 1, {
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(a[3].statusCode).toBe(429);
    // Same proxy, different real client: not lumped together.
    expect(b.statusCode).toBe(200);
  });

  it('uses the right-most untrusted hop, so clients cannot spoof their IP', async () => {
    app = await buildApp({}, { trustProxy: PROXY });

    // The client prepends fake addresses; the proxy appends the real one.
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/public',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` },
      });
      expect(res.statusCode).toBe(i < 3 ? 200 : 429);
    }
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    app = await buildApp();

    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(
        await app.inject({
          method: 'GET',
          url: '/public',
          remoteAddress: '203.0.113.50',
          headers: { 'x-forwarded-for': `198.51.100.${i}` },
        })
      );
    }
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
  });
});

describe('route classification', () => {
  const route = (method: string | string[], url: string, extra: Partial<RouteOptions> = {}) =>
    ({ method, url, handler: async () => ({}), ...extra }) as RouteOptions;

  it('classifies the real application routes from the central config', () => {
    const classify = (r: RouteOptions) =>
      classifyRoute(r, RATE_LIMIT_POLICIES, RATE_LIMIT_RULES, RATE_LIMIT_EXEMPTIONS);

    expect(classify(route('GET', '/health'))).toBe('exempt');
    expect(classify(route('HEAD', '/readiness'))).toBe('exempt');
    expect(classify(route('OPTIONS', '/*'))).toBe('exempt');
    expect(classify(route('POST', '/api/v1/auth/login'))).toBe('sensitive');
    expect(classify(route('POST', '/api/v1/transactions/tip', { preHandler: [authMiddleware] }))).toBe(
      'sensitive'
    );
    expect(classify(route('POST', '/api/v1/jobs/export', { preHandler: authMiddleware }))).toBe(
      'sensitive'
    );
    expect(classify(route('GET', '/api/v1/users/profile', { preHandler: authMiddleware }))).toBe(
      'authenticated'
    );
    expect(classify(route('GET', '/api/v1/admin/moderation', { preHandler: requireAdmin }))).toBe(
      'authenticated'
    );
    expect(classify(route('GET', '/api/v1/creators/:id'))).toBe('public');
  });

  it('applies the strictest class to a multi-method route', () => {
    const rules = [{ method: 'POST', url: '/thing', class: 'sensitive' as const }];
    expect(classifyRoute(route(['GET', 'POST'], '/thing'), POLICIES, rules, [])).toBe('sensitive');
    expect(
      classifyRoute(route(['GET', 'POST'], '/probe'), POLICIES, [], [{ method: 'GET', url: '/probe' }])
    ).toBe('public');
  });

  it('matches prefix patterns', () => {
    const rules = [{ url: '/api/v1/jobs/*', class: 'sensitive' as const }];
    expect(classifyRoute(route('POST', '/api/v1/jobs/email'), POLICIES, rules, [])).toBe('sensitive');
    expect(classifyRoute(route('GET', '/api/v1/jobs'), POLICIES, rules, [])).toBe('sensitive');
    expect(classifyRoute(route('GET', '/api/v1/jobsx'), POLICIES, rules, [])).toBe('public');
  });
});

describe('parseTrustProxy', () => {
  it('parses booleans, hop counts and address lists', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});
