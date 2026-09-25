import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { queryCache } from '../../db/query-cache';

export class AnalyticsService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Get earnings over time for a creator (using DB-level aggregation & 5m caching)
   */
  async getEarningsOverTime(
    creatorId: string,
    days = 30
  ): Promise<
    {
      date: string;
      earnings: number;
      tipCount: number;
    }[]
  > {
    return this.executeWithLogging('analytics.earningsOverTime', async () => {
      const cacheKey = `analytics:earnings:${creatorId}:${days}`;
      const cached = queryCache.get<{ date: string; earnings: number; tipCount: number }[]>(cacheKey);
      if (cached) {
        return cached;
      }

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Perform optimized query using index on (creatorId, status, createdAt)
      const tips = await this.prisma.tip.findMany({
        where: {
          creatorId,
          status: 'confirmed',
          createdAt: { gte: startDate },
        },
        select: {
          amount: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      // Group by date
      const groupedByDate: Record<string, { earnings: number; count: number }> = {};

      for (const tip of tips) {
        const date = tip.createdAt.toISOString().split('T')[0];
        if (!groupedByDate[date]) {
          groupedByDate[date] = { earnings: 0, count: 0 };
        }
        groupedByDate[date].earnings += tip.amount;
        groupedByDate[date].count += 1;
      }

      const result = Object.entries(groupedByDate)
        .map(([date, data]) => ({
          date,
          earnings: Math.round(data.earnings * 100) / 100,
          tipCount: data.count,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Cache for 5 minutes with creator tag
      queryCache.set(cacheKey, result, 300000, [`analytics:creator:${creatorId}`]);

      return result;
    });
  }

  /**
   * Get top supporters for a creator (using database groupBy & index)
   */
  async getTopSupporters(
    creatorId: string,
    limit = 10
  ): Promise<
    {
      userId: string;
      totalAmount: number;
      tipCount: number;
      lastTipDate: string;
    }[]
  > {
    return this.executeWithLogging('analytics.topSupporters', async () => {
      const cacheKey = `analytics:topSupporters:${creatorId}:${limit}`;
      const cached = queryCache.get<{ userId: string; totalAmount: number; tipCount: number; lastTipDate: string }[]>(cacheKey);
      if (cached) {
        return cached;
      }

      const supporters = await this.prisma.tip.groupBy({
        by: ['fromUserId'],
        where: {
          creatorId,
          status: 'confirmed',
        },
        _sum: { amount: true },
        _count: { id: true },
        _max: { createdAt: true },
        orderBy: [{ _sum: { amount: 'desc' } }, { fromUserId: 'asc' }],
        take: boundedLimit,
      });

      const result = supporters.map((supporter) => ({
        userId: supporter.fromUserId,
        totalAmount: Math.round((supporter._sum.amount || 0) * 100) / 100,
        tipCount: supporter._count.id,
        lastTipDate: (supporter._max.createdAt || new Date()).toISOString(),
      }));

      queryCache.set(cacheKey, result, 300000, [`analytics:creator:${creatorId}`]);
      return result;
    });
  }

  /**
   * Get tip frequency statistics (using single database aggregate instead of loading all rows)
   */
  async getTipFrequency(
    creatorId: string,
    days = 30
  ): Promise<{
    totalTips: number;
    averageTipAmount: number;
    largestTip: number;
    smallestTip: number;
    tipsPerDay: number;
    totalEarnings: number;
  }> {
    return this.executeWithLogging('analytics.tipFrequency', async () => {
      const cacheKey = `analytics:frequency:${creatorId}:${days}`;
      const cached = queryCache.get<{
        totalTips: number;
        averageTipAmount: number;
        largestTip: number;
        smallestTip: number;
        tipsPerDay: number;
        totalEarnings: number;
      }>(cacheKey);
      if (cached) {
        return cached;
      }

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Single database aggregate query using indexes
      const stats = await this.prisma.tip.aggregate({
        where: {
          creatorId,
          status: 'confirmed',
          createdAt: { gte: startDate },
        },
        _count: { id: true },
        _sum: { amount: true },
        _avg: { amount: true },
        _max: { amount: true },
        _min: { amount: true },
      });

      const totalTips = stats._count.id || 0;
      if (totalTips === 0) {
        const emptyResult = {
          totalTips: 0,
          averageTipAmount: 0,
          largestTip: 0,
          smallestTip: 0,
          tipsPerDay: 0,
          totalEarnings: 0,
        };
        queryCache.set(cacheKey, emptyResult, 300000, [`analytics:creator:${creatorId}`]);
        return emptyResult;
      }

      const totalEarnings = stats._sum.amount || 0;
      const averageTipAmount = stats._avg.amount || 0;
      const largestTip = stats._max.amount || 0;
      const smallestTip = stats._min.amount || 0;
      const tipsPerDay = totalTips / days;

      const result = {
        totalTips,
        averageTipAmount: Math.round(averageTipAmount * 100) / 100,
        largestTip: stats._max.amount || 0,
        smallestTip: stats._min.amount || 0,
        tipsPerDay: Math.round(tipsPerDay * 100) / 100,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
      };

      queryCache.set(cacheKey, result, 300000, [`analytics:creator:${creatorId}`]);
      return result;
    });
  }

  /**
   * Get summary stats for a creator (optimized aggregate query)
   */
  async getSummaryStats(creatorId: string): Promise<{
    totalEarnings: number;
    totalTips: number;
    uniqueSupporters: number;
    averageTipAmount: number;
  }> {
    return this.executeWithLogging('analytics.summary', async () => {
      const cacheKey = `analytics:summary:${creatorId}`;
      const cached = queryCache.get<{
        totalEarnings: number;
        totalTips: number;
        uniqueSupporters: number;
        averageTipAmount: number;
      }>(cacheKey);
      if (cached) {
        return cached;
      }

      const [stats, uniqueSupporters] = await Promise.all([
        this.prisma.tip.aggregate({
          where: {
            creatorId,
            status: 'confirmed',
          },
          _count: { id: true },
          _sum: { amount: true },
          _avg: { amount: true },
        }),
        this.prisma.tip.findMany({
          where: {
            creatorId,
            status: 'confirmed',
          },
          distinct: ['fromUserId'],
          select: { fromUserId: true },
        }),
      ]);

      const totalTips = stats._count.id || 0;
      const totalEarnings = stats._sum.amount || 0;
      const averageTipAmount = stats._avg.amount || 0;

      const result = {
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalTips,
        uniqueSupporters: uniqueSupporters.length,
        averageTipAmount: Math.round(averageTipAmount * 100) / 100,
      };

      queryCache.set(cacheKey, result, 300000, [`analytics:creator:${creatorId}`]);
      return result;
    });
  }

  /**
   * Invalidate analytics cache for a creator when new tips/payouts occur
   */
  invalidateCreatorCache(creatorId: string): void {
    queryCache.invalidateTags([`analytics:creator:${creatorId}`]);
  }
}

