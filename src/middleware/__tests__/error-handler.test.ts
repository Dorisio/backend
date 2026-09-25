import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildErrorResponse, globalErrorHandler, normalizeError, notFoundHandler } from '../error-handler';
import {
  AppError,
  ConflictError,
  ErrorCodes,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../../utils/errors';
import { getErrorStats, resetErrorTracking } from '../../lib/error-tracking';

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler(globalErrorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get('/app-error', async () => {
    throw new NotFoundError('Tip');
  });

  app.get('/validation', async () => {
    throw new ValidationError('Amount must be greater than 0', { field: 'amount' });
  });

  app.get('/unauthorized', async () => {
    throw new UnauthorizedError('Missing or invalid authorization header');
  });

  app.get('/forbidden', async () => {
    throw new ForbiddenError();
  });

  app.get('/conflict', async () => {
    throw new ConflictError('Email already registered');
  });

  app.get('/rate-limit', async () => {
    throw new TooManyRequestsError('Rate limit exceeded. Maximum 10 tips per hour.');
  });

  app.get('/zod', async () => {
    z.object({ amount: z.number().positive() }).parse({ amount: -1 });
  });

  app.get('/unknown', async () => {
    throw new Error('connection string postgres://user:pass@host/db leaked here');
  });

  app.get('/internal-exposed', async () => {
    throw new InternalServerError('internal secret detail');
  });

  app.get('/prisma-conflict', async () => {
    const error: any = new Error('Unique constraint failed on the fields: (`email`)');
    error.name = 'PrismaClientKnownRequestError';
    error.code = 'P2002';
    throw error;
  });

  app.get('/prisma-missing', async () => {
    const error: any = new Error('Record to update not found.');
    error.name = 'PrismaClientKnownRequestError';
    error.code = 'P2025';
    throw error;
  });

  app.get('/prisma-down', async () => {
    const error: any = new Error("Can't reach database server");
    error.name = 'PrismaClientKnownRequestError';
    error.code = 'P1001';
    throw error;
  });

  app.get('/prisma-unknown', async () => {
    const error: any = new Error('raw driver failure with table details');
    error.name = 'PrismaClientUnknownRequestError';
    throw error;
  });

  app.get('/jwt', async () => {
    const error: any = new Error('jwt malformed');
    error.name = 'JsonWebTokenError';
    throw error;
  });

  app.get('/localized', async () => {
    throw new ValidationError('The request data is invalid');
  });

  app.get('/contest', async () => {
    throw new ValidationError('Contest is not open');
  });

  return app;
}

describe('global error handler', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetErrorTracking();
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const expectEnvelope = (
    body: any,
    expected: { status: number; code: string; message?: string }
  ): void => {
    expect(typeof body.timestamp).toBe('string');
    expect(body.success).toBe(false);
    expect(body.error.code).toBe(expected.code);
    if (expected.message !== undefined) {
      expect(body.error.message).toBe(expected.message);
    }
  };

  it('returns the standardized envelope for AppError instances', async () => {
    const res = await app.inject({ method: 'GET', url: '/app-error' });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.json(), { status: 404, code: ErrorCodes.NOT_FOUND, message: 'Tip not found' });
  });

  it('maps status codes to the correct HTTP response', async () => {
    const cases: Array<[string, number, string]> = [
      ['/validation', 400, ErrorCodes.VALIDATION_ERROR],
      ['/unauthorized', 401, ErrorCodes.UNAUTHORIZED],
      ['/forbidden', 403, ErrorCodes.FORBIDDEN],
      ['/conflict', 409, ErrorCodes.CONFLICT],
      ['/rate-limit', 429, ErrorCodes.RATE_LIMIT_EXCEEDED],
      ['/prisma-down', 503, ErrorCodes.DATABASE_UNAVAILABLE],
    ];

    for (const [url, status, code] of cases) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(status);
      expectEnvelope(res.json(), { status, code });
    }
  });

  it('includes structured details for operational errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/validation' });
    const body = res.json();
    expect(body.error.details).toEqual({ field: 'amount' });
  });

  it('formats Zod validation errors as a 400 with field issues', async () => {
    const res = await app.inject({ method: 'GET', url: '/zod' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expectEnvelope(body, { status: 400, code: ErrorCodes.VALIDATION_ERROR });
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    expect(body.error.details.issues[0].path).toBe('amount');
  });

  it('never exposes message or stack for unexpected errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/unknown' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expectEnvelope(body, {
      status: 500,
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('.ts:');
  });

  it('never exposes messages of explicitly non-exposing 5xx errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal-exposed' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toContain('internal secret detail');
  });

  it('wraps Prisma known errors into API errors', async () => {
    const conflict = await app.inject({ method: 'GET', url: '/prisma-conflict' });
    expect(conflict.statusCode).toBe(409);
    expectEnvelope(conflict.json(), { status: 409, code: ErrorCodes.CONFLICT });

    const missing = await app.inject({ method: 'GET', url: '/prisma-missing' });
    expect(missing.statusCode).toBe(404);
    expectEnvelope(missing.json(), { status: 404, code: ErrorCodes.NOT_FOUND });
  });

  it('does not leak raw database messages for unmapped Prisma errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/prisma-unknown' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expectEnvelope(body, { status: 500, code: ErrorCodes.DATABASE_ERROR });
    expect(JSON.stringify(body)).not.toContain('raw driver failure');
  });

  it('maps JWT failures to 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/jwt' });
    expect(res.statusCode).toBe(401);
    expectEnvelope(res.json(), { status: 401, code: ErrorCodes.UNAUTHORIZED });
  });

  it('returns a standardized 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.json(), { status: 404, code: ErrorCodes.NOT_FOUND });
  });

  it('localizes generic messages based on Accept-Language', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/localized',
      headers: { 'accept-language': 'es-ES,es;q=0.9' },
    });
    const body = res.json();
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(body.error.message).toBe('Los datos de la solicitud no son válidos');
  });

  it('preserves domain-specific messages even when a locale is requested', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/contest',
      headers: { 'accept-language': 'fr' },
    });
    expect(res.json().error.message).toBe('Contest is not open');
  });

  it('tracks every handled error', async () => {
    await app.inject({ method: 'GET', url: '/validation' });
    await app.inject({ method: 'GET', url: '/unknown' });

    const stats = getErrorStats();
    expect(stats.total).toBe(2);
    expect(stats.byCode[ErrorCodes.VALIDATION_ERROR]).toBe(1);
    expect(stats.byCode[ErrorCodes.INTERNAL_ERROR]).toBe(1);
  });
});

describe('normalizeError', () => {
  it('normalizes AppError instances', () => {
    const normalized = normalizeError(new ValidationError('bad', { a: 1 }));
    expect(normalized).toMatchObject({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'bad',
      expose: true,
      operational: true,
      logLevel: 'warn',
    });
    expect(normalized.details).toEqual({ a: 1 });
  });

  it('treats non-Error throws as internal failures', () => {
    const normalized = normalizeError('boom');
    expect(normalized.statusCode).toBe(500);
    expect(normalized.expose).toBe(false);
  });
});

describe('buildErrorResponse', () => {
  it('omits details when the error is not exposed', () => {
    const body = buildErrorResponse({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'raw internals',
      details: { secret: true },
      expose: false,
      operational: false,
      logLevel: 'error',
    });

    expect(body.error.details).toBeUndefined();
    expect(body.error.message).toBe('An unexpected error occurred');
  });

  it('keeps details when the error is exposed', () => {
    const body = buildErrorResponse({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'bad',
      details: { field: 'amount' },
      expose: true,
      operational: true,
      logLevel: 'warn',
    });

    expect(body.error.details).toEqual({ field: 'amount' });
  });
});
