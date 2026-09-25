import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryCache, isReadOnlyQuery } from '../query-cache';

describe('QueryCache', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache({
      defaultTtlMs: 200,
      maxEntries: 3,
    });
  });

  it('should generate deterministic keys for SQL queries and parameters', () => {
    const key1 = cache.generateKey('SELECT * FROM "User" WHERE id = $1', ['123']);
    const key2 = cache.generateKey('SELECT * FROM "User" WHERE id = $1', ['123']);
    const key3 = cache.generateKey('SELECT * FROM "User" WHERE id = $1', ['456']);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('must not collide for different statements that differ only in literals', () => {
    // Literal normalization is right for log grouping, wrong for cache
    // identity: `SELECT ... WHERE id = 1` and `... = 2` are different reads.
    const key1 = cache.generateKey('SELECT * FROM "Tip" WHERE id = 1');
    const key2 = cache.generateKey('SELECT * FROM "Tip" WHERE id = 2');
    const formatted = cache.generateKey('SELECT   *\n  FROM "Tip" WHERE id = 1');

    expect(key1).not.toBe(key2);
    expect(key1).toBe(formatted);
  });

  it('should not treat a cached null as a miss', () => {
    const key = cache.generateKey('SELECT nothing');
    cache.set(key, null);

    expect(cache.lookup(key)).toEqual({ hit: true, value: null });
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(0);
  });

  it('should read without side effects via peek', () => {
    const key = cache.generateKey('SELECT peeked');
    cache.set(key, { value: 1 });

    expect(cache.peek(key).hit).toBe(true);
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  it('should load once for concurrent callers of the same key', async () => {
    const loader = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [1] }), 20))
    );
    const key = cache.generateKey('SELECT single-flight');

    const results = await Promise.all([
      cache.getOrLoad(key, loader),
      cache.getOrLoad(key, loader),
      cache.getOrLoad(key, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[2]);
    expect(cache.getStats().size).toBe(1);
  });

  it('should re-load once the cached value expired', async () => {
    const loader = vi.fn(async () => ({ value: 1 }));
    const key = cache.generateKey('SELECT expiring');

    await cache.getOrLoad(key, loader, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cache.getOrLoad(key, loader, 30);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('should let the caller opt out of hit/miss bookkeeping', async () => {
    const loader = vi.fn(async () => 1);
    const key = cache.generateKey('SELECT untracked');

    await cache.getOrLoad(key, loader, undefined, [], false);
    await cache.getOrLoad(key, loader, undefined, [], false);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  it('should cap caller supplied TTLs at the configured maximum', async () => {
    const bounded = new QueryCache({ defaultTtlMs: 1000, maxTtlMs: 60 });
    const key = bounded.generateKey('SELECT capped');

    bounded.set(key, { value: 1 }, 10 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(bounded.get(key)).toBeNull();
  });

  it('should purge expired entries on demand', async () => {
    const cache2 = new QueryCache({ defaultTtlMs: 30, maxEntries: 10 });
    const stale = cache2.generateKey('SELECT stale');
    const fresh = cache2.generateKey('SELECT fresh');

    cache2.set(stale, 1, 20);
    cache2.set(fresh, 2, 5000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cache2.purgeExpired()).toBe(1);
    expect(cache2.getStats().size).toBe(1);
    expect(cache2.get(fresh)).toBe(2);
  });

  it('should report a hit rate and reset statistics', () => {
    const key = cache.generateKey('SELECT stats');
    cache.set(key, 1);
    cache.get(key);
    cache.get('missing-key');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.sets).toBe(1);
    expect(stats.hitRate).toBe(0.5);

    cache.resetStats();
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
    expect(cache.getStats().hitRate).toBe(0);
  });

  it('should store and retrieve data within TTL', () => {
    const key = cache.generateKey('SELECT 1');
    cache.set(key, { count: 1 });

    const cached = cache.get<{ count: number }>(key);
    expect(cached).toEqual({ count: 1 });

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
    expect(stats.size).toBe(1);
  });

  it('should return null and increment misses for expired entries', async () => {
    const key = cache.generateKey('SELECT 2');
    cache.set(key, { count: 2 }, 50); // 50ms TTL

    await new Promise((resolve) => setTimeout(resolve, 80));

    const result = cache.get(key);
    expect(result).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  it('should invalidate specific key', () => {
    const key = cache.generateKey('SELECT 3');
    cache.set(key, { val: 'test' });

    expect(cache.get(key)).toEqual({ val: 'test' });
    const deleted = cache.invalidateKey(key);
    expect(deleted).toBe(true);
    expect(cache.get(key)).toBeNull();
  });

  it('should invalidate entries by tags', () => {
    const key1 = cache.generateKey('SELECT user 1');
    const key2 = cache.generateKey('SELECT user 2');
    const key3 = cache.generateKey('SELECT creator 1');

    cache.set(key1, { user: 1 }, 10000, ['users', 'user:1']);
    cache.set(key2, { user: 2 }, 10000, ['users', 'user:2']);
    cache.set(key3, { creator: 1 }, 10000, ['creators']);

    expect(cache.get(key1)).toBeDefined();
    expect(cache.get(key2)).toBeDefined();
    expect(cache.get(key3)).toBeDefined();

    const invalidated = cache.invalidateTags(['users']);
    expect(invalidated).toBe(2);

    expect(cache.get(key1)).toBeNull();
    expect(cache.get(key2)).toBeNull();
    expect(cache.get(key3)).toEqual({ creator: 1 });
  });

  it('should evict oldest entries when maxEntries is exceeded', () => {
    cache.set('key1', 1);
    cache.set('key2', 2);
    cache.set('key3', 3);
    expect(cache.getStats().size).toBe(3);

    // Adding 4th item should evict oldest (key1)
    cache.set('key4', 4);
    expect(cache.getStats().size).toBe(3);
    expect(cache.getStats().evictions).toBe(1);
    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key4')).toBe(4);
  });

  it('should clear all entries', () => {
    cache.set('k1', 1);
    cache.set('k2', 2);
    cache.clear();
    expect(cache.getStats().size).toBe(0);
    expect(cache.get('k1')).toBeNull();
  });
});

describe('isReadOnlyQuery', () => {
  it('accepts read statements', () => {
    expect(isReadOnlyQuery('SELECT * FROM "User"')).toBe(true);
    expect(isReadOnlyQuery('  select 1 ')).toBe(true);
    expect(isReadOnlyQuery('WITH recent AS (SELECT 1) SELECT * FROM recent')).toBe(true);
    expect(isReadOnlyQuery('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadOnlyQuery('/* comment */ SELECT 1')).toBe(true);
  });

  it('rejects writes and session mutations', () => {
    expect(isReadOnlyQuery('INSERT INTO "Tip" VALUES (1)')).toBe(false);
    expect(isReadOnlyQuery('UPDATE "Tip" SET amount = 1')).toBe(false);
    expect(isReadOnlyQuery('DELETE FROM "Tip"')).toBe(false);
    expect(isReadOnlyQuery('TRUNCATE TABLE "Tip"')).toBe(false);
    expect(isReadOnlyQuery('SET search_path = public')).toBe(false);
    expect(isReadOnlyQuery('BEGIN')).toBe(false);
    expect(isReadOnlyQuery('DROP TABLE "Tip"')).toBe(false);
  });

  it('rejects empty or non-string input', () => {
    expect(isReadOnlyQuery('')).toBe(false);
    expect(isReadOnlyQuery('   ')).toBe(false);
    expect(isReadOnlyQuery(undefined as unknown as string)).toBe(false);
    expect(isReadOnlyQuery('-- only a comment')).toBe(false);
  });
});
