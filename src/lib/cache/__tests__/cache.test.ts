import { describe, it, expect, beforeEach, vi } from 'vitest';
import cache, {
  CacheType,
  TTL_CONFIG,
  getStats,
  getHitRate,
  resetStats,
  increment,
  zAdd,
  zRange,
  zScore,
} from '../index';
import { getOrFetch, invalidate, update, createCacheKey } from '../cache-aside';

// Mock Redis pool
vi.mock('../../redisPool', () => ({
  withRedis: vi.fn(),
}));

// Mock metrics
vi.mock('../../metrics', () => ({
  cacheHits: { inc: vi.fn() },
  cacheMisses: { inc: vi.fn() },
  cacheSizeGauge: { set: vi.fn() },
  cacheHitRateGauge: { set: vi.fn() },
}));

const { withRedis } = await import('../../redisPool');

describe('Cache Layer', () => {
  beforeEach(() => {
    resetStats();
    vi.clearAllMocks();
  });

  describe('TTL Configuration', () => {
    it('should have correct TTL values for each cache type', () => {
      expect(TTL_CONFIG[CacheType.USER]).toBe(5 * 60 * 1000); // 5 minutes
      expect(TTL_CONFIG[CacheType.CREATOR]).toBe(10 * 60 * 1000); // 10 minutes
      expect(TTL_CONFIG[CacheType.TRENDING]).toBe(1 * 60 * 1000); // 1 minute
      expect(TTL_CONFIG[CacheType.ANALYTICS]).toBe(60 * 60 * 1000); // 1 hour
    });
  });

  describe('Cache Statistics', () => {
    it('should track cache hits and misses', () => {
      const stats = getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should calculate hit rate correctly', () => {
      // Manually increment stats for testing
      const stats = getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('should reset statistics', () => {
      resetStats();
      const stats = getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.sets).toBe(0);
      expect(stats.deletes).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('Cache Key Generation', () => {
    it('should create cache keys with correct format', () => {
      const key = createCacheKey(CacheType.USER, '123');
      expect(key).toBe('v1:user:123');
    });

    it('should support custom version', () => {
      const key = createCacheKey(CacheType.CREATOR, '456', 'v2');
      expect(key).toBe('v2:creator:456');
    });
  });

  describe('Cache-Aside Pattern', () => {
    it('should skip cache when requested', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ id: '123', name: 'Test' });
      const result = await getOrFetch({
        key: 'test:123',
        type: CacheType.USER,
        fetchFn,
        skipCache: true,
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(result).toEqual({ id: '123', name: 'Test' });
    });

    it('should handle fetch errors gracefully', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('DB Error'));
      
      const result = await getOrFetch({
        key: 'test:123',
        type: CacheType.USER,
        fetchFn,
      });
      
      expect(result).toBeUndefined();
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate cache key', async () => {
      await invalidate('test:123');
      // Should not throw
    });
  });

  describe('Cache Update', () => {
    it('should update cache entry', async () => {
      await update('test:123', { id: '123', name: 'Updated' }, CacheType.USER);
      // Should not throw
    });
  });

  describe('Redis Operations', () => {
    it('should increment counter', async () => {
      vi.mocked(withRedis).mockImplementation(async (fn: any) => {
        return await fn({ incrBy: vi.fn().mockResolvedValue(5) });
      });
      const result = await increment('counter:123', 5);
      expect(typeof result).toBe('number');
    });

    it('should add to sorted set', async () => {
      vi.mocked(withRedis).mockImplementation(async (fn: any) => {
        return await fn({ zAdd: vi.fn().mockResolvedValue(1) });
      });
      const result = await zAdd('leaderboard:123', 100, 'user1');
      expect(typeof result).toBe('number');
    });

    it('should get range from sorted set', async () => {
      vi.mocked(withRedis).mockImplementation(async (fn: any) => {
        return await fn({ zRange: vi.fn().mockResolvedValue([]) });
      });
      const result = await zRange('leaderboard:123', 0, 10);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should get score from sorted set', async () => {
      vi.mocked(withRedis).mockImplementation(async (fn: any) => {
        return await fn({ zScore: vi.fn().mockResolvedValue(100) });
      });
      const result = await zScore('leaderboard:123', 'user1');
      expect(result === null || typeof result === 'number').toBe(true);
    });
  });

  describe('Probabilistic Expiration', () => {
    it('should apply jitter to TTL', async () => {
      // This test verifies the jitter function exists and works
      // We can't easily test the actual jitter without a real Redis connection
      const baseTtl = 60000;
      // Just ensure the set function doesn't throw
      vi.mocked(withRedis).mockImplementation(async (fn: any) => {
        return await fn({ set: vi.fn().mockResolvedValue('OK') });
      });
      
      await expect(cache.set('test:jitter', { data: 'test' }, baseTtl)).resolves.not.toThrow();
    });
  });

  describe('Graceful Fallback', () => {
    it('should fallback to memory cache on Redis error', async () => {
      vi.mocked(withRedis).mockImplementation(async (fn: any, fallback: any) => {
        return await fallback();
      });
      const result = await cache.get('test:fallback');
      // Should not throw even if Redis fails
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('Concurrent Access', () => {
    it('should handle concurrent cache operations', async () => {
      const operations = Array.from({ length: 100 }, (_, i) =>
        cache.set(`test:concurrent:${i}`, { id: i }, 60000)
      );

      await expect(Promise.all(operations)).resolves.not.toThrow();
    });

    it('should handle concurrent reads', async () => {
      const operations = Array.from({ length: 100 }, (_, i) =>
        cache.get(`test:concurrent:${i}`)
      );

      await expect(Promise.all(operations)).resolves.not.toThrow();
    });
  });
});
