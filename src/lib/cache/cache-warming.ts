import { PrismaClient } from '@prisma/client';
import cache, { CacheType, TTL_CONFIG } from './index';
import { makeKey } from './index';

// Helper function to create cache keys
function createCacheKey(type: CacheType, id: string): string {
  return makeKey('v1', type, id);
}
import { logger } from '../../utils/logger';
import { cacheConfig } from '../../config/cache';

/**
 * Cache warming service
 * 
 * Preloads frequently accessed data into cache on application startup
 * to reduce cold start latency and improve hit rates.
 */

export class CacheWarmer {
  constructor(private prisma: PrismaClient) {}

  /**
   * Warm up cache with top creators
   * Loads the top N creators by earnings into cache
   */
  async warmTopCreators(limit: number = cacheConfig.warmupBatchSize): Promise<void> {
    if (!cacheConfig.warmupEnabled) {
      logger.info('Cache warming is disabled');
      return;
    }

    logger.info(`Starting cache warming for top ${limit} creators`);

    try {
      const creators = await this.prisma.creator.findMany({
        take: limit,
        orderBy: {
          totalEarnings: 'desc',
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      logger.info(`Found ${creators.length} creators to warm cache`);

      // Cache each creator
      const warmPromises = creators.map(async (creator) => {
        const key = createCacheKey(CacheType.CREATOR, creator.id);
        const ttl = TTL_CONFIG[CacheType.CREATOR];
        
        try {
          await cache.set(key, creator, ttl);
          logger.debug(`Warmed cache for creator: ${creator.username} (${creator.id})`);
        } catch (error) {
          logger.error(`Failed to warm cache for creator ${creator.id}`, error);
        }
      });

      await Promise.all(warmPromises);
      logger.info(`Cache warming completed for ${creators.length} creators`);
    } catch (error) {
      logger.error('Cache warming failed for creators', error);
    }
  }

  /**
   * Warm up cache with trending data
   * Loads recent tips and activity data
   */
  async warmTrendingData(): Promise<void> {
    if (!cacheConfig.warmupEnabled) {
      return;
    }

    logger.info('Starting cache warming for trending data');

    try {
      // Get recent confirmed tips (last 24 hours)
      const oneDayAgo = new Date();
      oneDayAgo.setHours(oneDayAgo.getHours() - 24);

      const recentTips = await this.prisma.tip.findMany({
        where: {
          status: 'confirmed',
          createdAt: { gte: oneDayAgo },
        },
        take: 100,
        orderBy: {
          createdAt: 'desc',
        },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
              displayName: true,
            },
          },
        },
      });

      // Cache trending tips
      const trendingKey = createCacheKey(CacheType.TRENDING, 'recent-tips');
      await cache.set(trendingKey, recentTips, TTL_CONFIG[CacheType.TRENDING]);

      logger.info(`Warmed cache with ${recentTips.length} recent tips`);
    } catch (error) {
      logger.error('Cache warming failed for trending data', error);
    }
  }

  /**
   * Warm up cache for specific user
   * Useful for preloading data for authenticated users
   */
  async warmUser(userId: string): Promise<void> {
    logger.info(`Starting cache warming for user: ${userId}`);

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        logger.warn(`User not found for cache warming: ${userId}`);
        return;
      }

      const key = createCacheKey(CacheType.USER, userId);
      await cache.set(key, user, TTL_CONFIG[CacheType.USER]);

      logger.debug(`Warmed cache for user: ${userId}`);
    } catch (error) {
      logger.error(`Cache warming failed for user ${userId}`, error);
    }
  }

  /**
   * Warm up cache for analytics data
   * Loads summary statistics for top creators
   */
  async warmAnalyticsData(): Promise<void> {
    if (!cacheConfig.warmupEnabled) {
      return;
    }

    logger.info('Starting cache warming for analytics data');

    try {
      // Get overall platform stats
      const [totalUsers, totalCreators, totalTips, totalEarnings] = await Promise.all([
        this.prisma.user.count(),
        this.prisma.creator.count(),
        this.prisma.tip.count({ where: { status: 'confirmed' } }),
        this.prisma.tip.aggregate({
          where: { status: 'confirmed' },
          _sum: { amount: true },
        }),
      ]);

      const analyticsKey = createCacheKey(CacheType.ANALYTICS, 'platform-stats');
      const analyticsData = {
        totalUsers,
        totalCreators,
        totalTips,
        totalEarnings: totalEarnings._sum.amount || 0,
        updatedAt: new Date().toISOString(),
      };

      await cache.set(analyticsKey, analyticsData, TTL_CONFIG[CacheType.ANALYTICS]);

      logger.info('Warmed cache with platform analytics');
    } catch (error) {
      logger.error('Cache warming failed for analytics data', error);
    }
  }

  /**
   * Execute full cache warming routine
   * Warms all configured data types
   */
  async warmAll(): Promise<void> {
    if (!cacheConfig.warmupEnabled) {
      logger.info('Cache warming is disabled, skipping');
      return;
    }

    logger.info('Starting full cache warming routine');

    const startTime = Date.now();

    try {
      // Run all warming operations in parallel
      await Promise.all([
        this.warmTopCreators(),
        this.warmTrendingData(),
        this.warmAnalyticsData(),
      ]);

      const duration = Date.now() - startTime;
      logger.info(`Full cache warming completed in ${duration}ms`);
    } catch (error) {
      logger.error('Full cache warming failed', error);
    }
  }

  /**
   * Warm up cache for a specific creator
   * Useful for manual cache warming
   */
  async warmCreator(creatorId: string): Promise<void> {
    logger.info(`Starting cache warming for creator: ${creatorId}`);

    try {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      if (!creator) {
        logger.warn(`Creator not found for cache warming: ${creatorId}`);
        return;
      }

      const key = createCacheKey(CacheType.CREATOR, creatorId);
      await cache.set(key, creator, TTL_CONFIG[CacheType.CREATOR]);

      logger.debug(`Warmed cache for creator: ${creator.username} (${creatorId})`);
    } catch (error) {
      logger.error(`Cache warming failed for creator ${creatorId}`, error);
    }
  }
}

/**
 * Initialize cache warming on application startup
 */
export async function initializeCacheWarming(prisma: PrismaClient): Promise<void> {
  const warmer = new CacheWarmer(prisma);
  await warmer.warmAll();
}
