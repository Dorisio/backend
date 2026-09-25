import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { sanitizePageSize } from '../../utils/pagination';

export class AnalyticsService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Get earnings over time for a creator.
   *
   * Rows are bucketed in PostgreSQL (date_trunc) instead of loading every tip
   * into the process and grouping in JavaScript, so memory stays flat as the
   * time range grows.
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
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const rows = await this.prisma.$queryRaw<
        { date: Date; earnings: number; tipCount: bigint }[]
      >`
        SELECT date_trunc('day', "createdAt") AS date,
               COALESCE(SUM(amount), 0)::float AS earnings,
               COUNT(*)::bigint AS "tipCount"
        FROM "Tip"
        WHERE "creatorId" = ${creatorId}
          AND status = 'confirmed'
          AND "createdAt" >= ${startDate}
        GROUP BY 1
        ORDER BY 1 ASC
      `;

      return rows.map((row) => ({
        date: (row.date instanceof Date ? row.date : new Date(row.date)).toISOString().split('T')[0],
        earnings: Number(row.earnings ?? 0),
        tipCount: Number(row.tipCount ?? 0),
      }));
    });
  }

  /**
   * Get top supporters for a creator (grouped server-side).
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
      const boundedLimit = sanitizePageSize(limit, 10);
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

      return supporters.map((supporter) => ({
        userId: supporter.fromUserId,
        totalAmount: supporter._sum.amount || 0,
        tipCount: supporter._count.id,
        lastTipDate: (supporter._max.createdAt || new Date()).toISOString(),
      }));
    });
  }

  /**
   * Get tip frequency statistics (aggregated in the database).
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
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const stats = await this.prisma.tip.aggregate({
        where: {
          creatorId,
          status: 'confirmed',
          createdAt: { gte: startDate },
        },
        _sum: { amount: true },
        _avg: { amount: true },
        _max: { amount: true },
        _min: { amount: true },
        _count: { id: true },
      });

      const totalTips = stats._count.id;

      if (totalTips === 0) {
        return {
          totalTips: 0,
          averageTipAmount: 0,
          largestTip: 0,
          smallestTip: 0,
          tipsPerDay: 0,
          totalEarnings: 0,
        };
      }

      const totalEarnings = stats._sum.amount || 0;
      const averageTipAmount = stats._avg.amount || 0;
      const tipsPerDay = totalTips / days;

      return {
        totalTips,
        averageTipAmount: Math.round(averageTipAmount * 100) / 100,
        largestTip: stats._max.amount || 0,
        smallestTip: stats._min.amount || 0,
        tipsPerDay: Math.round(tipsPerDay * 100) / 100,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
      };
    });
  }

  /**
   * Get summary stats for a creator.
   *
   * A single aggregated round-trip computes the totals and
   * COUNT(DISTINCT "fromUserId") in SQL, so no per-supporter rows are
   * materialized in the process.
   */
  async getSummaryStats(creatorId: string): Promise<{
    totalEarnings: number;
    totalTips: number;
    uniqueSupporters: number;
    averageTipAmount: number;
  }> {
    return this.executeWithLogging('analytics.summary', async () => {
      const rows = await this.prisma.$queryRaw<
        { totalEarnings: number; totalTips: bigint; uniqueSupporters: bigint; averageTipAmount: number | null }[]
      >`
        SELECT COALESCE(SUM(amount), 0)::float AS "totalEarnings",
               COUNT(*)::bigint AS "totalTips",
               COUNT(DISTINCT "fromUserId")::bigint AS "uniqueSupporters",
               AVG(amount)::float AS "averageTipAmount"
        FROM "Tip"
        WHERE "creatorId" = ${creatorId} AND status = 'confirmed'
      `;

      const row = rows[0];

      return {
        totalEarnings: Math.round(Number(row?.totalEarnings ?? 0) * 100) / 100,
        totalTips: Number(row?.totalTips ?? 0),
        uniqueSupporters: Number(row?.uniqueSupporters ?? 0),
        averageTipAmount: Math.round(Number(row?.averageTipAmount ?? 0) * 100) / 100,
      };
    });
  }
}
