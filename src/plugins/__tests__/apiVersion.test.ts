import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerApiVersioning, deprecateRoute, SUPPORTED_API_VERSIONS } from '../apiVersion';

describe('registerApiVersioning (#25)', () => {
  it('lists v1 as the currently supported version', () => {
    expect(SUPPORTED_API_VERSIONS).toContain('1');
  });

  it('allows a request with no API-Version header', async () => {
    const app = Fastify();
    registerApiVersioning(app);
    app.get('/api/v1/ping', async () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/api/v1/ping' });

    expect(response.statusCode).toBe(200);
  });

  it('allows a request with a supported API-Version header', async () => {
    const app = Fastify();
    registerApiVersioning(app);
    app.get('/api/v1/ping', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      headers: { 'api-version': '1' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a request with an unsupported API-Version header with 400', async () => {
    const app = Fastify();
    registerApiVersioning(app);
    app.get('/api/v1/ping', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ping',
      headers: { 'api-version': '99' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('UNSUPPORTED_API_VERSION');
  });
});

describe('deprecateRoute (#25)', () => {
  it('adds Deprecation, Sunset, and Warning headers to the response', async () => {
    const app = Fastify();
    app.get(
      '/api/v1/old-thing',
      {
        onSend: deprecateRoute({
          sunsetDate: '2027-01-01',
          message: 'Use GET /api/v2/new-thing instead',
        }),
      },
      async () => ({ ok: true })
    );

    const response = await app.inject({ method: 'GET', url: '/api/v1/old-thing' });

    expect(response.headers['deprecation']).toBe('true');
    expect(response.headers['sunset']).toBe('2027-01-01');
    expect(response.headers['warning']).toContain('Use GET /api/v2/new-thing instead');
  });

  it('adds a Link header when migrationGuideUrl is provided', async () => {
    const app = Fastify();
    app.get(
      '/api/v1/old-thing',
      {
        onSend: deprecateRoute({
          sunsetDate: '2027-01-01',
          message: 'See migration guide',
          migrationGuideUrl: 'https://docs.example.com/migrate',
        }),
      },
      async () => ({ ok: true })
    );

    const response = await app.inject({ method: 'GET', url: '/api/v1/old-thing' });

    expect(response.headers['link']).toContain('https://docs.example.com/migrate');
    expect(response.headers['link']).toContain('rel="deprecation"');
  });
});
