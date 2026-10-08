import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { loadConfig, resetConfigCache } from '../config/loader';
import { serviceAuthMiddleware, requireServiceRole, requireServiceScope } from './service-auth';

const key = 'current-secret-key-very-long';
function app() {
  const server = Fastify({ logger: false });
  server.get('/plain', { preHandler: serviceAuthMiddleware }, async (request) => ({
    id: request.service?.id,
    scopes: request.service?.scopes,
  }));
  server.get('/role', { preHandler: requireServiceRole('worker') }, async () => ({ ok: true }));
  server.get('/scope', { preHandler: requireServiceScope('read:users') }, async () => ({
    ok: true,
  }));
  return server;
}
function configure(keys: unknown, extra: Record<string, string> = {}) {
  resetConfigCache();
  loadConfig({
    loadEnvFiles: false,
    env: {
      NODE_ENV: 'test',
      INTERNAL_SERVICE_AUTH_ENABLED: 'true',
      INTERNAL_SERVICE_API_KEYS: JSON.stringify(keys),
      ...extra,
    },
  });
}

describe('service authentication', () => {
  beforeEach(() =>
    configure([
      {
        id: 'billing',
        key,
        scopes: ['read:users'],
        roles: ['worker'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ])
  );
  it('accepts a current key and attaches typed identity', async () => {
    const response = await app().inject({
      method: 'GET',
      url: '/plain',
      headers: { 'x-internal-api-key': key },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'billing', scopes: ['read:users'] });
  });
  it.each([
    ['missing', {}],
    ['malformed', { authorization: 'Bearer nope' }],
    ['wrong', { 'x-internal-api-key': 'wrong' }],
  ])('rejects %s credentials', async (_name, headers) => {
    const response = await app().inject({ method: 'GET', url: '/plain', headers });
    expect(response.statusCode).toBe(401);
  });
  it('rejects an expired key and accepts a non-expired previous rotation key', async () => {
    configure([
      {
        id: 'billing',
        key: 'new-key',
        previousKeys: [{ key: 'old-key', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
        expiresAt: new Date(Date.now() - 1).toISOString(),
        scopes: [],
        roles: [],
      },
    ]);
    const old = await app().inject({
      method: 'GET',
      url: '/plain',
      headers: { 'x-internal-api-key': 'old-key' },
    });
    expect(old.statusCode).toBe(200);
    const expiredOld = new Date(Date.now() - 1).toISOString();
    configure([
      { id: 'billing', key: 'new-key', previousKeys: [{ key: 'old-key', expiresAt: expiredOld }] },
    ]);
    expect(
      (
        await app().inject({
          method: 'GET',
          url: '/plain',
          headers: { 'x-internal-api-key': 'old-key' },
        })
      ).statusCode
    ).toBe(401);
  });
  it('enforces roles and scopes with 403 after authentication', async () => {
    expect(
      (await app().inject({ method: 'GET', url: '/role', headers: { 'x-internal-api-key': key } }))
        .statusCode
    ).toBe(200);
    configure([{ id: 'billing', key, scopes: [], roles: [] }]);
    expect(
      (await app().inject({ method: 'GET', url: '/role', headers: { 'x-internal-api-key': key } }))
        .statusCode
    ).toBe(403);
    expect(
      (await app().inject({ method: 'GET', url: '/scope', headers: { 'x-internal-api-key': key } }))
        .statusCode
    ).toBe(403);
  });
  it('fails closed when configuration is disabled', async () => {
    resetConfigCache();
    loadConfig({
      loadEnvFiles: false,
      env: { NODE_ENV: 'test', INTERNAL_SERVICE_AUTH_ENABLED: 'false' },
    });
    expect(
      (await app().inject({ method: 'GET', url: '/plain', headers: { 'x-internal-api-key': key } }))
        .statusCode
    ).toBe(401);
  });
  it('never trusts arbitrary client-cert headers for mTLS', async () => {
    configure([{ id: 'billing', key }], { INTERNAL_SERVICE_MTLS_ENABLED: 'true' });
    const response = await app().inject({
      method: 'GET',
      url: '/plain',
      headers: { 'x-internal-api-key': key, 'x-client-cert': 'trusted' },
    });
    expect(response.statusCode).toBe(401);
  });
});
