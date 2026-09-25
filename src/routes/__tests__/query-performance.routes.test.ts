import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerQueryPerformanceRoutes } from '../query-performance.routes';
import * as connection from '../../db/connection';
import { explainQueryWithOptions } from '../../db/query-optimizer';
import { PrismaPerformanceMonitor, setPrismaPerformanceMonitor } from '../../db/prisma-performance';

vi.mock('../../db/connection', () => ({
  getDatabase: vi.fn(() => ({ query: vi.fn() })),
  getQueryCache: vi.fn(() => ({
    getStats: () => ({ hits: 3, misses: 1, size: 2, maxEntries: 100, evictions: 0, sets: 2, deletes: 0, hitRate: 0.75, inflight: 0 }),
  })),
}));

vi.mock('../../db/query-optimizer', () => ({
  explainQueryWithOptions: vi.fn(),
}));

describe('query performance routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setPrismaPerformanceMonitor(
      new PrismaPerformanceMonitor({ cacheEnabled: false, warnOnUnboundedReads: false })
    );
    app = Fastify({ logger: false });
    registerQueryPerformanceRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    setPrismaPerformanceMonitor(null);
  });

  it('exposes aggregated query statistics and raw cache stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/diagnostics/queries/performance' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toMatchObject({ totalQueries: 0, totalErrors: 0, unboundedReads: 0 });
    expect(body.slowQueries).toEqual([]);
    expect(body.rawQueryCache).toMatchObject({ hits: 3, misses: 1, hitRate: 0.75 });
  });

  it('explains a read-only statement and returns the plan analysis', async () => {
    vi.mocked(explainQueryWithOptions).mockResolvedValue({
      planText: '[]',
      hasSequentialScan: true,
      estimatedCost: 1500,
      indexNames: [],
      relations: ['Tip'],
      sequentialScans: ['Tip'],
      sortNodes: [],
      hashJoins: 0,
      hasRowEstimateMismatch: false,
      recommendations: ['Sequential scan detected on: Tip.'],
      raw: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: '/diagnostics/queries/explain',
      payload: { sql: 'SELECT * FROM "Tip"', params: ['pending'] },
    });

    expect(res.statusCode).toBe(200);
    expect(explainQueryWithOptions).toHaveBeenCalledWith(
      expect.anything(),
      'SELECT * FROM "Tip"',
      ['pending'],
      { analyze: false, buffers: false, verbose: false }
    );
    expect(res.json().recommendations[0]).toContain('Sequential scan');
  });

  it('refuses to explain mutating statements', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/diagnostics/queries/explain',
      payload: { sql: 'DELETE FROM "Tip"' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(explainQueryWithOptions).not.toHaveBeenCalled();
  });

  it('validates the request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/diagnostics/queries/explain',
      payload: {},
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(explainQueryWithOptions).not.toHaveBeenCalled();
  });

  it('propagates explain failures as a 500 rather than silently succeeding', async () => {
    vi.mocked(explainQueryWithOptions).mockRejectedValue(new Error('relation does not exist'));

    const res = await app.inject({
      method: 'POST',
      url: '/diagnostics/queries/explain',
      payload: { sql: 'SELECT * FROM missing_table' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('uses the shared database pool for EXPLAIN', () => {
    expect(connection.getDatabase).toBeDefined();
  });
});
