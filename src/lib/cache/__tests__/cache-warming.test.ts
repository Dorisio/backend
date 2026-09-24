import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheWarmer } from '../cache-warming';
import cache from '../index';

// Mock Prisma
const mockPrisma = {
  creator: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
  tip: {
    findMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  user: {
    count: vi.fn(),
    findUnique: vi.fn(),
  },
};

// Mock cache config
vi.mock('../../config/cache', () => ({
  cacheConfig: {
    host: 'localhost',
    port: 6379,
    password: undefined,
    db: 0,
    keyPrefix: 'app',
    keyVersion: 'v1',
    defaultTtlSeconds: 300,
    warmupEnabled: true,
    warmupBatchSize: 100,
    metricsEnabled: true,
  },
}));

// Mock cache
vi.mock('../index', () => ({
  default: {
    set: vi.fn().mockResolvedValue(undefined),
  },
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
  createCacheKey: vi.fn((type, id) => `v1:${type}:${id}`),
}));

describe('Cache Warming Service', () => {
  let warmer: CacheWarmer;

  beforeEach(() => {
    vi.clearAllMocks();
    warmer = new CacheWarmer(mockPrisma as any);
  });

  describe('warmTopCreators', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.creator.findMany.mockRejectedValue(new Error('DB Error'));

      await expect(warmer.warmTopCreators(10)).resolves.not.toThrow();
    });
  });

  describe('warmTrendingData', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.tip.findMany.mockRejectedValue(new Error('DB Error'));

      await expect(warmer.warmTrendingData()).resolves.not.toThrow();
    });
  });

  describe('warmUser', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.user.findUnique.mockRejectedValue(new Error('DB Error'));

      await expect(warmer.warmUser('123')).resolves.not.toThrow();
    });
  });

  describe('warmAnalyticsData', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.user.count.mockRejectedValue(new Error('DB Error'));

      await expect(warmer.warmAnalyticsData()).resolves.not.toThrow();
    });
  });

  describe('warmAll', () => {
    it('should handle partial failures gracefully', async () => {
      vi.spyOn(warmer, 'warmTopCreators').mockRejectedValue(new Error('Error'));
      vi.spyOn(warmer, 'warmTrendingData').mockResolvedValue();
      vi.spyOn(warmer, 'warmAnalyticsData').mockResolvedValue();

      await expect(warmer.warmAll()).resolves.not.toThrow();
    });
  });

  describe('warmCreator', () => {
    it('should handle database errors gracefully', async () => {
      mockPrisma.creator.findUnique.mockRejectedValue(new Error('DB Error'));

      await expect(warmer.warmCreator('123')).resolves.not.toThrow();
    });
  });
});
