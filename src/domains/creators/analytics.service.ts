import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ValidationError } from '../../utils/errors';
import { sanitizePageSize } from '../../utils/pagination';

export class AnalyticsService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getCreatorEarnings(creatorId: string): Promise<{
    totalEarnings: number;
    pendingBalance: number;
    tipCount: number;
    averageTip: number;
  }> {
    return this.executeWithLogging('analytics.getCreatorEarnings', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        select: { pendingBalance: true },
      });

      if (!creator) {
        throw new ValidationError('Creator not found');
      }

      // Aggregate in the database instead of loading every tip row into memory.
      const aggregates = await this.prisma.tip.aggregate({
        where: { creatorId },
        _sum: { amount: true },
        _count: { id: true },
      });

      const totalEarnings = aggregates._sum.amount || 0;
      const tipCount = aggregates._count.id;

      return {
        totalEarnings,
        pendingBalance: creator.pendingBalance,
        tipCount,
        averageTip: tipCount > 0 ? totalEarnings / tipCount : 0,
      };
    });
  }

  async recordTipEarning(creatorId: string, amount: number): Promise<void> {
    return this.executeWithLogging('analytics.recordTipEarning', async () => {
      await this.prisma.creator.update({
        where: { id: creatorId },
        data: {
          pendingBalance: {
            increment: amount,
          },
        },
      });
    });
  }

  async getTopCreators(limit: number = 10): Promise<any[]> {
    return this.executeWithLogging('analytics.getTopCreators', async () => {
      const creators = await this.prisma.creator.findMany({
        take: sanitizePageSize(limit, 10),
        orderBy: [
          { totalEarnings: 'desc' },
          { id: 'desc' },
        ],
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          verified: true,
          totalEarnings: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return creators;
    });
  }
}
