import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSecurityPlugins, rateLimitCorsPreflight } from '../security';

describe('CORS & security headers (Issue #28)', () => {
  beforeEach(() => {
    process.env.CORS_ORIGINS = 'http://localhost:5173';
    process.env.CORS_CREDENTIALS = 'true';
  });

  it('emits CORS headers for an allowed origin', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    app.get('/ping', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['x-frame-options']?.toString().toLowerCase()).toContain('deny');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('handles preflight OPTIONS for allowed origins', async () => {
    const app = Fastify({ logger: false });
    await registerSecurityPlugins(app);
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/users/profile',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });

    expect([204, 200]).toContain(res.statusCode);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rate-limits excessive preflight requests', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    app.addHook('onRequest', async (req, reply) => {
      // pin IP for inject-based tests
      Object.defineProperty(req, 'ip', { value: '203.0.113.10' });
      await rateLimitCorsPreflight(req, reply);
    });
    app.options('/x', async (_req, reply) => reply.code(204).send());
    await app.ready();

    let limited = false;
    for (let i = 0; i < 70; i++) {
      const res = await app.inject({ method: 'OPTIONS', url: '/x' });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
