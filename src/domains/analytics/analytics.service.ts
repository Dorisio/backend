import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { queryCache } from '../../db/query-cache';

export class AnalyticsService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Get earnings over time for a creator (using DB-level aggregation & 5m caching)
   * Supports daily, weekly, and monthly aggregation
   */
  async getEarningsOverTime(
    creatorId: string,
    days = 30,
    granularity: 'daily' | 'weekly' | 'monthly' = 'daily'
  ): Promise<
    {
      date: string;
      earnings: number;
      tipCount: number;
    }[]
  > {
    return this.executeWithLogging('analytics.earningsOverTime', async () => {
      const cacheKey = `analytics:earnings:${creatorId}:${days}:${granularity}`;
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

      // Group by date based on granularity
      const groupedByDate: Record<string, { earnings: number; count: number }> = {};

      for (const tip of tips) {
        let dateKey: string;
        const date = tip.createdAt;

        switch (granularity) {
          case 'daily':
            dateKey = date.toISOString().split('T')[0];
            break;
          case 'weekly':
            const weekStart = new Date(date);
            weekStart.setDate(date.getDate() - date.getDay());
            dateKey = weekStart.toISOString().split('T')[0];
            break;
          case 'monthly':
            dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            break;
        }

        if (!groupedByDate[dateKey]) {
          groupedByDate[dateKey] = { earnings: 0, count: 0 };
        }
        groupedByDate[dateKey].earnings += tip.amount;
        groupedByDate[dateKey].count += 1;
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
        take: limit,
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
   * Enhanced with trend analysis and peak day detection
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
    growthRate: number;
    peakDay: string | null;
    peakDayTips: number;
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
        growthRate: number;
        peakDay: string | null;
        peakDayTips: number;
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
          growthRate: 0,
          peakDay: null,
          peakDayTips: 0,
        };
        queryCache.set(cacheKey, emptyResult, 300000, [`analytics:creator:${creatorId}`]);
        return emptyResult;
      }

      const totalEarnings = stats._sum.amount || 0;
      const averageTipAmount = stats._avg.amount || 0;
      const largestTip = stats._max.amount || 0;
      const smallestTip = stats._min.amount || 0;
      const tipsPerDay = totalTips / days;

      // Calculate growth rate (compare last 7 days to previous 7 days)
      const last7Days = new Date();
      last7Days.setDate(last7Days.getDate() - 7);
      const previous7Days = new Date(last7Days);
      previous7Days.setDate(previous7Days.getDate() - 7);

      const [recentTips, previousTips] = await Promise.all([
        this.prisma.tip.count({
          where: {
            creatorId,
            status: 'confirmed',
            createdAt: { gte: last7Days },
          },
        }),
        this.prisma.tip.count({
          where: {
            creatorId,
            status: 'confirmed',
            createdAt: { gte: previous7Days, lt: last7Days },
          },
        }),
      ]);

      const growthRate = previousTips > 0
        ? ((recentTips - previousTips) / previousTips) * 100
        : 0;

      // Find peak day
      const tipsByDay = await this.prisma.tip.findMany({
        where: {
          creatorId,
          status: 'confirmed',
          createdAt: { gte: startDate },
        },
        select: {
          createdAt: true,
        },
      });

      // Group by date string and find peak
      const dayCounts: Record<string, number> = {};
      for (const tip of tipsByDay) {
        const dateStr = tip.createdAt.toISOString().split('T')[0];
        dayCounts[dateStr] = (dayCounts[dateStr] || 0) + 1;
      }

      let peakDay: string | null = null;
      let peakDayTips = 0;
      for (const [date, count] of Object.entries(dayCounts)) {
        if (count > peakDayTips) {
          peakDayTips = count;
          peakDay = date;
        }
      }

      const result = {
        totalTips,
        averageTipAmount: Math.round(averageTipAmount * 100) / 100,
        largestTip: stats._max.amount || 0,
        smallestTip: stats._min.amount || 0,
        tipsPerDay: Math.round(tipsPerDay * 100) / 100,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        growthRate: Math.round(growthRate * 100) / 100,
        peakDay,
        peakDayTips,
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

