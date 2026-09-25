import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrFetch, invalidate, update, createCacheKey, CacheType } from '../cache-aside';
import cache from '../index';

// Mock the cache module
vi.mock('../index', () => ({
  default: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  makeKey: (version: string, namespace: string, id: string) => `${version}:${namespace}:${id}`,
  CacheType: {
    USER: 'user',
    CREATOR: 'creator',
    TRENDING: 'trending',
    ANALYTICS: 'analytics',
  },
  TTL_CONFIG: {
    user: 300000,
    creator: 600000,
    trending: 60000,
    analytics: 3600000,
  },
}));

describe('Cache-Aside Pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrFetch', () => {
    it('should return cached data on hit', async () => {
      const cachedData = { id: '123', name: 'Cached User' };
      vi.mocked(cache.get).mockResolvedValue(cachedData);
      const fetchFn = vi.fn();

      const result = await getOrFetch({
        key: 'user:123',
        type: CacheType.USER,
        fetchFn,
      });

      expect(result).toEqual(cachedData);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(cache.get).toHaveBeenCalledWith('user:123');
    });

    it('should fetch and cache on miss', async () => {
      const freshData = { id: '123', name: 'Fresh User' };
      vi.mocked(cache.get).mockResolvedValue(null);
      vi.mocked(cache.set).mockResolvedValue(undefined);
      const fetchFn = vi.fn().mockResolvedValue(freshData);

      const result = await getOrFetch({
        key: 'user:123',
        type: CacheType.USER,
        fetchFn,
      });

      expect(result).toEqual(freshData);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(cache.set).toHaveBeenCalledWith('user:123', freshData, 300000);
    });

    it('should skip cache when skipCache is true', async () => {
      const freshData = { id: '123', name: 'Fresh User' };
      const fetchFn = vi.fn().mockResolvedValue(freshData);

      const result = await getOrFetch({
        key: 'user:123',
        type: CacheType.USER,
        fetchFn,
        skipCache: true,
      });

      expect(result).toEqual(freshData);
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('should use custom TTL when provided', async () => {
      const freshData = { id: '123', name: 'Fresh User' };
      vi.mocked(cache.get).mockResolvedValue(null);
      vi.mocked(cache.set).mockResolvedValue(undefined);
      const fetchFn = vi.fn().mockResolvedValue(freshData);
      const customTtl = 120000;

      await getOrFetch({
        key: 'user:123',
        type: CacheType.USER,
        fetchFn,
        ttlMs: customTtl,
      });

      expect(cache.set).toHaveBeenCalledWith('user:123', freshData, customTtl);
    });

    it('should fallback to fetch on cache error', async () => {
      const freshData = { id: '123', name: 'Fresh User' };
      vi.mocked(cache.get).mockRejectedValue(new Error('Redis error'));
      vi.mocked(cache.set).mockResolvedValue(undefined);
      const fetchFn = vi.fn().mockResolvedValue(freshData);

      const result = await getOrFetch({
        key: 'user:123',
        type: CacheType.USER,
        fetchFn,
      });

      expect(result).toEqual(freshData);
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('should throw when both cache and fetch fail', async () => {
      vi.mocked(cache.get).mockRejectedValue(new Error('Redis error'));
      const fetchFn = vi.fn().mockRejectedValue(new Error('DB error'));

      await expect(
        getOrFetch({
          key: 'user:123',
          type: CacheType.USER,
          fetchFn,
        })
      ).rejects.toThrow('DB error');
    });
  });

  describe('invalidate', () => {
    it('should delete cache key', async () => {
      vi.mocked(cache.del).mockResolvedValue(undefined);

      await invalidate('user:123');

      expect(cache.del).toHaveBeenCalledWith('user:123');
    });

    it('should handle cache deletion errors gracefully', async () => {
      vi.mocked(cache.del).mockRejectedValue(new Error('Redis error'));

      await expect(invalidate('user:123')).resolves.not.toThrow();
    });
  });

  describe('update', () => {
    it('should update cache entry', async () => {
      const data = { id: '123', name: 'Updated User' };
      vi.mocked(cache.set).mockResolvedValue(undefined);

      await update('user:123', data, CacheType.USER);

      expect(cache.set).toHaveBeenCalledWith('user:123', data, 300000);
    });

    it('should use custom TTL when provided', async () => {
      const data = { id: '123', name: 'Updated User' };
      vi.mocked(cache.set).mockResolvedValue(undefined);
      const customTtl = 120000;

      await update('user:123', data, CacheType.USER, customTtl);

      expect(cache.set).toHaveBeenCalledWith('user:123', data, customTtl);
    });

    it('should handle cache update errors gracefully', async () => {
      const data = { id: '123', name: 'Updated User' };
      vi.mocked(cache.set).mockRejectedValue(new Error('Redis error'));

      await expect(update('user:123', data, CacheType.USER)).resolves.not.toThrow();
    });
  });

  describe('createCacheKey', () => {
    it('should create cache key with default version', () => {
      const key = createCacheKey(CacheType.USER, '123');
      expect(key).toBe('v1:user:123');
    });

    it('should create cache key with custom version', () => {
      const key = createCacheKey(CacheType.CREATOR, '456', 'v2');
      expect(key).toBe('v2:creator:456');
    });

    it('should handle different cache types', () => {
      const userKey = createCacheKey(CacheType.USER, '123');
      const creatorKey = createCacheKey(CacheType.CREATOR, '456');
      const trendingKey = createCacheKey(CacheType.TRENDING, 'tips');
      const analyticsKey = createCacheKey(CacheType.ANALYTICS, 'stats');

      expect(userKey).toBe('v1:user:123');
      expect(creatorKey).toBe('v1:creator:456');
      expect(trendingKey).toBe('v1:trending:tips');
      expect(analyticsKey).toBe('v1:analytics:stats');
    });
  });

  describe('batchGetOrFetch', () => {
    it('should fetch multiple items in parallel', async () => {
      const fetchFn1 = vi.fn().mockResolvedValue({ id: '1' });
      const fetchFn2 = vi.fn().mockResolvedValue({ id: '2' });
      const fetchFn3 = vi.fn().mockResolvedValue({ id: '3' });

      const { batchGetOrFetch } = await import('../cache-aside');

      const results = await batchGetOrFetch([
        { key: 'user:1', type: CacheType.USER, fetchFn: fetchFn1 },
        { key: 'user:2', type: CacheType.USER, fetchFn: fetchFn2 },
        { key: 'user:3', type: CacheType.USER, fetchFn: fetchFn3 },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: '1' });
      expect(results[1]).toEqual({ id: '2' });
      expect(results[2]).toEqual({ id: '3' });
    });
  });
});
