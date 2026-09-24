import { describe, it, expect, beforeEach } from 'vitest';
import { QueryCache } from '../query-cache';

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
