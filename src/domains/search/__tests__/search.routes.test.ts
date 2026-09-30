import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerSearchRoutes } from '../search.routes';
import { applyJsonSerializer } from '../../../config/serialization';
import { globalErrorHandler } from '../../../middleware/error-handler';

// Minimal in-memory Prisma stand-in covering only what the search service
// touches. Lets the route handlers and service run without a database or Redis.
class FakePrisma {
  $queryRaw = vi.fn(async () => []);
  creator = {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
  };
  searchQuery = {
    upsert: vi.fn(async () => ({})),
    findMany: vi.fn(async () => []),
  };
}

async function request(app: FastifyInstance, url: string) {
  return app.inject({ url, method: 'GET' });
}

describe('search.routes validation', () => {
  let app: FastifyInstance;
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
    app = Fastify({ logger: false });
    // Mirror production wiring: the JSON serializer keeps response schemas
    // documentation-only, and the global error handler converts ValidationError
    // into the standard { success, error: { code, message } } envelope.
    applyJsonSerializer(app);
    app.setErrorHandler(globalErrorHandler);
    registerSearchRoutes(app, prisma as never);
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects a query longer than 200 chars', async () => {
    const res = await request(app, '/api/v1/search?q=' + 'x'.repeat(201));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body as string);
    expect(body.error?.message).toBe('Invalid search parameters');
    expect(JSON.stringify(body.error?.details)).toMatch(/Search query must be at most 200/);
  });

  it('accepts a valid q with page and pageSize', async () => {
    const res = await request(app, '/api/v1/search?q=test&page=1&pageSize=20');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.success).toBe(true);
  });

  it('rejects an invalid verified value', async () => {
    const res = await request(app, '/api/v1/search?verified=maybe');
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body as string);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid page number', async () => {
    const res = await request(app, '/api/v1/search?q=art&page=0');
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body as string);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a too-long category', async () => {
    const res = await request(app, '/api/v1/search?category=' + 'x'.repeat(51));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a too-long tag', async () => {
    const res = await request(app, '/api/v1/search?tag=' + 'x'.repeat(51));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a too-long autocomplete query', async () => {
    const res = await request(app, '/api/v1/search/autocomplete?q=' + 'x'.repeat(101));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a too-short autocomplete query', async () => {
    const res = await request(app, '/api/v1/search/autocomplete?q=');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-integer limit for trending', async () => {
    const res = await request(app, '/api/v1/search/trending?limit=abc');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a limit outside 1..50 for trending', async () => {
    const res = await request(app, '/api/v1/search/trending?limit=0');
    expect(res.statusCode).toBe(400);
  });

  it('accepts a valid trending limit', async () => {
    const res = await request(app, '/api/v1/search/trending?limit=5');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.success).toBe(true);
  });
});
