import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { getRequestContext } from '../../lib/requestContext';
import { globalErrorHandler, notFoundHandler } from '../../middleware/error-handler';
import { registerRequestLogging } from '../requestLogging';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRequestLogging(app);
  app.setErrorHandler(globalErrorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.get('/context', async () => ({ requestId: getRequestContext()?.requestId }));
  app.get('/failure', async () => {
    throw new Error('internal failure');
  });
  return app;
}

describe('request logging and correlation', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => app.close());

  it('accepts a valid incoming ID, exposes it in ALS, and echoes it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: { 'x-request-id': 'gateway.req-42' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('gateway.req-42');
    expect(response.json()).toEqual({ requestId: 'gateway.req-42' });
  });

  it('replaces unsafe IDs and never reflects them', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: { 'x-request-id': 'unsafe id\r\nX-Injected: true' },
    });

    const requestId = response.headers['x-request-id'];
    expect(response.statusCode).toBe(200);
    expect(requestId).toEqual(expect.any(String));
    expect(requestId).not.toContain('unsafe');
    expect(response.json()).toEqual({ requestId });
  });

  it('echoes the correlation ID on handled errors and unknown routes', async () => {
    const failure = await app.inject({
      method: 'GET',
      url: '/failure',
      headers: { 'x-request-id': 'error.req-7' },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'not-found.req-8' },
    });

    expect(failure.statusCode).toBe(500);
    expect(failure.headers['x-request-id']).toBe('error.req-7');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-request-id']).toBe('not-found.req-8');
  });
});
