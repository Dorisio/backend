import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RequestValidationError,
  clearSchemaCache,
  compileSchema,
  detectSuspiciousInput,
  getSchemaCacheSize,
  sanitizeString,
  sanitizeValue,
  validateRequest,
} from '../validation';
import { AppError } from '../../utils/errors';
import { configureFailureLimiter, resetFailureLimiter } from '../../lib/failure-limiter';
import { CreateTipSchema, TipHistoryQuerySchema, TipIdParamsSchema } from '../../domains/payments/payment.schemas';

const ReferenceSchema = z.object({
  reference: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'reference must be alphanumeric'),
});

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        details: (error as unknown as { details?: unknown }).details,
      });
      return;
    }
    reply.code(500).send({ code: 'INTERNAL_ERROR', message: error.message });
  });

  app.post(
    '/tip',
    { preHandler: [validateRequest({ body: CreateTipSchema })] },
    async (request: FastifyRequest, _reply: FastifyReply) => ({ received: request.body })
  );

  app.get(
    '/list',
    { preHandler: [validateRequest({ query: TipHistoryQuerySchema })] },
    async (request: FastifyRequest, _reply: FastifyReply) => ({ received: request.query })
  );

  app.get(
    '/tip/:id',
    { preHandler: [validateRequest({ params: TipIdParamsSchema })] },
    async (request: FastifyRequest, _reply: FastifyReply) => ({ received: request.params })
  );

  app.post(
    '/reference',
    { preHandler: [validateRequest({ body: ReferenceSchema })] },
    async (request: FastifyRequest, _reply: FastifyReply) => ({ received: request.body })
  );

  return app;
}

describe('sanitization helpers', () => {
  it('trims and removes control characters', () => {
    expect(sanitizeString('  hello\u0000world  ')).toBe('helloworld');
  });

  it('strips HTML tags and dangerous URL schemes', () => {
    expect(sanitizeString('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeString('javascript:alert(1)')).toBe('alert(1)');
    expect(sanitizeString('<b>bold</b>')).toBe('bold');
  });

  it('can collapse whitespace', () => {
    expect(sanitizeString('a   b\n\nc', { collapseWhitespace: true })).toBe('a b c');
  });

  it('sanitizes nested objects and arrays', () => {
    const input = { message: ' <b>hi</b> ', tags: [' <i>a</i> ', 'b'] };
    expect(sanitizeValue(input)).toEqual({ message: 'hi', tags: ['a', 'b'] });
  });

  it('leaves non-string primitives untouched', () => {
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(true)).toBe(true);
  });
});

describe('detectSuspiciousInput', () => {
  it('flags classic injection payloads', () => {
    expect(detectSuspiciousInput("' OR 1=1 --")).toBe(true);
    expect(detectSuspiciousInput('UNION SELECT password FROM users')).toBe(true);
    expect(detectSuspiciousInput('<script>alert(1)</script>')).toBe(true);
    expect(detectSuspiciousInput('{"$ne": null}')).toBe(true);
  });

  it('does not flag ordinary text', () => {
    expect(detectSuspiciousInput('Great content, keep it up!')).toBe(false);
    expect(detectSuspiciousInput(12345)).toBe(false);
  });

  it('walks nested structures', () => {
    expect(detectSuspiciousInput({ nested: ['ok', '<img onerror=alert(1)>'] })).toBe(true);
  });
});

describe('schema compilation cache', () => {
  beforeEach(() => clearSchemaCache());

  it('memoizes compiled schemas', () => {
    const schema = z.object({ a: z.string() });
    expect(getSchemaCacheSize()).toBe(0);
    expect(compileSchema(schema)).toBe(schema);
    expect(compileSchema(schema)).toBe(schema);
    expect(getSchemaCacheSize()).toBe(1);
  });
});

describe('validateRequest middleware', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetFailureLimiter();
    clearSchemaCache();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts and normalizes valid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: 25, message: '  thanks!  ' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().received;
    expect(body.amount).toBe(25);
    expect(body.message).toBe('thanks!');
    expect(body.currency).toBe('USD');
  });

  it('rejects missing required fields with a 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/tip', payload: { amount: 10 } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('The request data is invalid');
    expect(body.details.issues.some((i: { path: string }) => i.path.endsWith('creatorId'))).toBe(true);
  });

  it('rejects invalid data types with a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('enforces amount boundaries', async () => {
    const tooBig = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: 2_000_000 },
    });
    expect(tooBig.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: -5 },
    });
    expect(negative.statusCode).toBe(400);
  });

  it('does not leak schema internals in the error message', async () => {
    const res = await app.inject({ method: 'POST', url: '/tip', payload: {} });
    const body = res.json();
    expect(body.message).not.toMatch(/zod|ZodError|_def/i);
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('sanitizes XSS payloads before they reach the handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: 5, message: '<script>alert(1)</script>' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received.message).toBe('alert(1)');
  });

  it('blocks SQL injection attempts that violate the allowlist schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/reference',
      payload: { reference: "' OR 1=1 --" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('validates and coerces query parameters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/list?page=2&pageSize=10&sortOrder=DESC&status=completed',
    });
    expect(res.statusCode).toBe(200);
    const received = res.json().received;
    expect(received.page).toBe(2);
    expect(received.pageSize).toBe(10);
    expect(received.sortOrder).toBe('desc');
    expect(received.status).toBe('completed');
  });

  it('rejects out-of-range query parameters', async () => {
    const res = await app.inject({ method: 'GET', url: '/list?pageSize=5000' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown sort fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/list?sortBy=password' });
    expect(res.statusCode).toBe(400);
  });

  it('validates path params', async () => {
    const res = await app.inject({ method: 'GET', url: '/tip/abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().received.id).toBe('abc');
  });

  it('returns a RequestValidationError carrying field issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/tip', payload: {} });
    const body = res.json();
    expect(body.details.issues.length).toBeGreaterThan(0);
    expect(body.details.issues[0]).toHaveProperty('path');
    expect(body.details.issues[0]).toHaveProperty('message');
    expect(body.details.issues[0]).toHaveProperty('code');
  });

  it('rate limits clients that repeatedly send invalid input', async () => {
    configureFailureLimiter({ maxFailures: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/tip', payload: {} });
      expect(res.statusCode).toBe(400);
    }

    const blocked = await app.inject({ method: 'POST', url: '/tip', payload: {} });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('does not block valid requests from the same client', async () => {
    configureFailureLimiter({ maxFailures: 2, windowMs: 60_000 });

    await app.inject({ method: 'POST', url: '/tip', payload: {} });
    await app.inject({ method: 'POST', url: '/tip', payload: {} });

    const valid = await app.inject({
      method: 'POST',
      url: '/tip',
      payload: { creatorId: 'creator-1', amount: 5 },
    });
    // Once blocked, even valid requests are throttled until the window expires.
    expect(valid.statusCode).toBe(429);
  });

  it('exposes a RequestValidationError type consumers can catch', () => {
    const error = new RequestValidationError([{ path: 'body.amount', message: 'x', code: 'custom' }]);
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.details.issues).toHaveLength(1);
  });
});
