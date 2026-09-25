import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PrismaPerformanceMonitor,
  buildPrismaCacheKey,
  createInstrumentedPrismaClient,
  getPrismaPerformanceMonitor,
  setPrismaPerformanceMonitor,
  __testing,
} from '../prisma-performance';

type OperationContext = {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * Minimal stand-in for a Prisma client: `$extends` returns an object that keeps
 * the registered extension so tests can invoke the `$allOperations` hook
 * directly.
 */
function createFakePrismaClient() {
  const extensions: Array<{
    query: { $allModels: { $allOperations: (ctx: OperationContext) => Promise<unknown> } };
  }> = [];

  return {
    extensions,
    client: {
      $extends(extension: (typeof extensions)[number]) {
        extensions.push(extension);
        return this;
      },
    } as unknown as Parameters<PrismaPerformanceMonitor['instrument']>[0],
    run: (ctx: OperationContext) => extensions[0].query.$allModels.$allOperations(ctx),
  };
}

const ok = (value: unknown) => () => Promise.resolve(value);

describe('PrismaPerformanceMonitor', () => {
  let monitor: PrismaPerformanceMonitor;

  beforeEach(() => {
    monitor = new PrismaPerformanceMonitor({
      cacheEnabled: true,
      slowQueryThresholdMs: 50,
      warnOnUnboundedReads: false,
    });
  });

  it('records duration, row counts and errors per operation', async () => {
    const fake = createFakePrismaClient();
    const client = monitor.instrument(fake.client);

    await fake.run({ model: 'User', operation: 'findMany', args: { take: 10 }, query: ok([{ id: 'a' }, { id: 'b' }]) });
    await expect(
      fake.run({
        model: 'User',
        operation: 'findUnique',
        args: { where: { id: 'a' } },
        query: () => Promise.reject(new Error('boom')),
      })
    ).rejects.toThrow('boom');

    const stats = monitor.getStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.totalErrors).toBe(1);
    expect(stats.operations['User.findMany'].rows).toBe(2);
    expect(stats.operations['User.findUnique'].errors).toBe(1);
    expect(stats.operations['User.findMany'].maxDurationMs).toBeGreaterThanOrEqual(0);
    expect(client).toBe(fake.client);
  });

  it('rethrows query errors so callers still see them', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    await expect(
      fake.run({
        model: 'User',
        operation: 'findUnique',
        args: { where: { id: 'x' } },
        query: () => Promise.reject(new Error('unique constraint failed')),
      })
    ).rejects.toThrow('unique constraint failed');
  });

  it('caches repeated reads and serves the second call from cache', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    const query = vi.fn(ok([{ id: 'a' }]));
    const first = await fake.run({ model: 'Creator', operation: 'findMany', args: { take: 5 }, query });
    const second = await fake.run({ model: 'Creator', operation: 'findMany', args: { take: 5 }, query });

    expect(query).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(monitor.getStats().cacheHits).toBe(1);
    expect(monitor.getStats().cacheMisses).toBe(1);
  });

  it('caches a null result as a hit instead of re-querying', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    const query = vi.fn(ok(null));
    await fake.run({ model: 'Creator', operation: 'findUnique', args: { where: { id: 'nope' } }, query });
    const second = await fake.run({ model: 'Creator', operation: 'findUnique', args: { where: { id: 'nope' } }, query });

    expect(query).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
  });

  it('invalidates cached reads for a model after a write', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    const read = vi.fn(ok([{ id: 'a' }]));
    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 5 }, query: read });
    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 5 }, query: read });
    expect(read).toHaveBeenCalledTimes(1);

    await fake.run({
      model: 'Tip',
      operation: 'create',
      args: { data: { amount: 1 } },
      query: ok({ id: 'tip-1' }),
    });

    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 5 }, query: read });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never caches reads that project credentials or signing material', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    const query = vi.fn(ok([{ id: 'u1', password: 'hash' }]));
    await fake.run({
      model: 'User',
      operation: 'findMany',
      args: { take: 5, select: { id: true, password: true } },
      query,
    });
    await fake.run({
      model: 'User',
      operation: 'findMany',
      args: { take: 5, select: { id: true, password: true } },
      query,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(monitor.getStats().cacheHits).toBe(0);
  });

  it('skips caching entirely when the cache is disabled', async () => {
    const uncached = new PrismaPerformanceMonitor({ cacheEnabled: false, warnOnUnboundedReads: false });
    const fake = createFakePrismaClient();
    uncached.instrument(fake.client);

    const query = vi.fn(ok([{ id: 'a' }]));
    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 5 }, query });
    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 5 }, query });

    expect(query).toHaveBeenCalledTimes(2);
    expect(uncached.getStats().cache.entries).toBe(0);
  });

  it('counts list reads issued without a take as unbounded', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    await fake.run({ model: 'Tip', operation: 'findMany', args: {}, query: ok([]) });

    expect(monitor.getStats().unboundedReads).toBe(1);
  });

  it('flags queries slower than the configured threshold', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    await fake.run({
      model: 'Creator',
      operation: 'findMany',
      args: { take: 1 },
      query: () => new Promise((resolve) => setTimeout(() => resolve([]), 80)),
    });

    expect(monitor.getStats().slowQueries).toBe(1);
  });

  it('collapses concurrent reads of the same key into one query', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    const query = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve([{ id: 'a' }]), 20))
    );

    const results = await Promise.all([
      fake.run({ model: 'Creator', operation: 'findMany', args: { take: 1 }, query }),
      fake.run({ model: 'Creator', operation: 'findMany', args: { take: 1 }, query }),
      fake.run({ model: 'Creator', operation: 'findMany', args: { take: 1 }, query }),
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[2]);
  });

  it('resets counters and the cache on demand', async () => {
    const fake = createFakePrismaClient();
    monitor.instrument(fake.client);

    await fake.run({ model: 'Tip', operation: 'findMany', args: { take: 2 }, query: ok([{ id: 'a' }]) });
    expect(monitor.getStats().totalQueries).toBe(1);

    monitor.resetStats();

    const stats = monitor.getStats();
    expect(stats.totalQueries).toBe(0);
    expect(stats.unboundedReads).toBe(0);
  });
});

describe('prisma-performance helpers', () => {
  it('builds a stable cache key that ignores key order but respects values', () => {
    const a = buildPrismaCacheKey('User', 'findMany', { take: 10, where: { role: 'fan' } });
    const b = buildPrismaCacheKey('User', 'findMany', { where: { role: 'fan' }, take: 10 });
    const c = buildPrismaCacheKey('User', 'findMany', { take: 20, where: { role: 'fan' } });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('serializes Date and BigInt values deterministically', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(buildPrismaCacheKey('Tip', 'findMany', { createdAt: date })).toBe(
      buildPrismaCacheKey('Tip', 'findMany', { createdAt: date })
    );
    expect(__testing.stableStringify({ big: 10n })).toContain('"10"');
  });

  it('detects sensitive projections at any depth', () => {
    expect(__testing.selectsSensitiveFields({ select: { password: true } })).toBe(true);
    expect(__testing.selectsSensitiveFields({ include: { user: { select: { apiKey: true } } } })).toBe(true);
    expect(__testing.selectsSensitiveFields({ select: { id: true, email: true } })).toBe(false);
    expect(__testing.selectsSensitiveFields({})).toBe(false);
  });

  it('counts rows returned by a query', () => {
    expect(__testing.countRows([1, 2, 3])).toBe(3);
    expect(__testing.countRows({ id: 1 })).toBe(1);
    expect(__testing.countRows(null)).toBe(0);
  });

  it('exposes a process-wide monitor that can be replaced', () => {
    setPrismaPerformanceMonitor(null);
    const first = getPrismaPerformanceMonitor();
    expect(getPrismaPerformanceMonitor()).toBe(first);

    const replacement = new PrismaPerformanceMonitor();
    setPrismaPerformanceMonitor(replacement);
    expect(getPrismaPerformanceMonitor()).toBe(replacement);

    setPrismaPerformanceMonitor(null);
  });
});

describe('createInstrumentedPrismaClient', () => {
  it('returns a client and monitor and registers the monitor globally', () => {
    const { client, monitor } = createInstrumentedPrismaClient({ cacheEnabled: false });

    expect(client).toBeDefined();
    expect(monitor).toBeInstanceOf(PrismaPerformanceMonitor);
    expect(getPrismaPerformanceMonitor()).toBe(monitor);

    setPrismaPerformanceMonitor(null);
  });
});
