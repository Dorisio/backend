import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cacheService, CacheService } from './cache';
import { cacheConfig } from '../config/cache';

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(() => {
    service = new CacheService({
      host: '127.0.0.1',
      port: 6379,
      db: 15,
      keyPrefix: 'test',
      keyVersion: 'v1',
      defaultTtlSeconds: 60,
      warmupEnabled: false,
    });
  });

  afterEach(async () => {
    await service.clearAll();
    await service.disconnect();
  });

  it('should connect to Redis', async () => {
    await service.connect();
    expect(service.isAvailable()).toBe(true);
  });

  it('should set and get cache entry', async () => {
    await service.connect();
    const testData = { id: 1, name: 'test' };
    await service.set('user:1', testData);
    const result = await service.get('user:1');
    expect(result).toEqual(testData);
  });

  it('should return null on cache miss', async () => {
    await service.connect();
    const result = await service.get('nonexistent:key');
    expect(result).toBeNull();
  });

  it('should respect TTL expiration', async () => {
    await service.connect();
    await service.set('expire:key', { value: 'test' }, 1);
    const result1 = await service.get('expire:key');
    expect(result1).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result2 = await service.get('expire:key');
    expect(result2).toBeNull();
  });

  it('should invalidate specific key', async () => {
    await service.connect();
    await service.set('invalidate:key', { value: 'test' });
    await service.del('invalidate:key');
    const result = await service.get('invalidate:key');
    expect(result).toBeNull();
  });

  it('should invalidate by pattern', async () => {
    await service.connect();
    await service.set('pattern:user:1', { id: 1 });
    await service.set('pattern:user:2', { id: 2 });
    const count = await service.invalidatePattern('pattern:user:*');
    expect(count).toBe(2);
    const result1 = await service.get('pattern:user:1');
    const result2 = await service.get('pattern:user:2');
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  it('should track cache metrics', async () => {
    await service.connect();
    await service.set('metric:key', { value: 'test' });
    await service.get('metric:key');
    await service.get('nonexistent');

    const metrics = service.getMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.setOps).toBe(1);
    expect(metrics.getOps).toBe(2);
  });

  it('should handle backend failure gracefully', async () => {
    const badService = new CacheService({
      host: '127.0.0.1',
      port: 9999,
      db: 15,
      keyPrefix: 'test',
      keyVersion: 'v1',
      defaultTtlSeconds: 60,
    });

    await badService.connect();
    const result = await badService.get('any:key');
    expect(result).toBeNull();
    expect(badService.isAvailable()).toBe(false);

    await badService.disconnect();
  });

  it('should prevent cache stampede with lock', async () => {
    await service.connect();
    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { id: 1 };
    };

    const results = await Promise.all([
      service.getWithLock('stampede:key', fetchFn),
      service.getWithLock('stampede:key', fetchFn),
      service.getWithLock('stampede:key', fetchFn),
    ]);

    expect(fetchCount).toBe(1);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it('should clear all cache entries', async () => {
    await service.connect();
    await service.set('clear:1', { id: 1 });
    await service.set('clear:2', { id: 2 });
    await service.clearAll();
    const result1 = await service.get('clear:1');
    const result2 = await service.get('clear:2');
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });
});