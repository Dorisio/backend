import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { CreatorPayoutRequest, PayoutHistoryResponse } from './creator.types';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export class PayoutService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Process payout from pending balance to total earnings
   * This moves pendingBalance to processed payout
   */
  async processPayout(creatorId: string, data: CreatorPayoutRequest): Promise<any> {
    return this.executeWithLogging('payout.process', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Validate amount doesn't exceed pending balance
      if (data.amount > creator.pendingBalance) {
        throw new ValidationError(
          `Payout amount exceeds pending balance. Available: ${creator.pendingBalance}`
        );
      }

      // Reduce pending balance
      const updatedCreator = await this.prisma.creator.update({
        where: { id: creatorId },
        data: {
          pendingBalance: {
            decrement: data.amount,
          },
        },
      });

      logger.info(`Payout processed for creator ${creatorId}: ${data.amount}`);

      return {
        id: creatorId,
        pendingBalance: updatedCreator.pendingBalance,
        payoutAmount: data.amount,
      };
    });
  }

  /**
   * Get creator's earnings breakdown
   */
  async getEarningsBreakdown(creatorId: string): Promise<any> {
    return this.executeWithLogging('payout.getEarningsBreakdown', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Count total tips
      const tipStats = await this.prisma.tip.aggregate({
        where: {
          creatorId,
          status: 'completed',
        },
        _count: true,
        _sum: {
          amount: true,
        },
      });

      const paidOut = creator.totalEarnings - creator.pendingBalance;

      return {
        totalEarnings: creator.totalEarnings,
        pendingBalance: creator.pendingBalance,
        paidOut,
        totalTips: tipStats._count,
        totalTipAmount: tipStats._sum.amount || 0,
      };
    });
  }

  /**
   * Get creator dashboard with recent tips and earnings
   */
  async getCreatorDashboard(creatorId: string): Promise<any> {
    return this.executeWithLogging('payout.getCreatorDashboard', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        include: {
          user: {
            select: {
              email: true,
              name: true,
            },
          },
        },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Get recent tips
      const recentTips = await this.prisma.tip.findMany({
        where: {
          creatorId,
        },
        include: {
          fromUser: {
            select: {
              name: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 10,
      });

      // Count total tips
      const totalTips = await this.prisma.tip.count({
        where: {
          creatorId,
        },
      });

      const paidOut = creator.totalEarnings - creator.pendingBalance;

      return {
        creator: {
          id: creator.id,
          username: creator.username,
          displayName: creator.displayName,
          bio: creator.bio,
          avatar: creator.avatar,
          verified: creator.verified,
          isPublic: creator.isPublic,
        },
        totalTips,
        recentTips: recentTips.map((tip) => ({
          id: tip.id,
          amount: tip.amount,
          senderName: tip.fromUser.name,
          message: tip.message,
          createdAt: tip.createdAt.toISOString(),
          status: tip.status,
        })),
        earnings: {
          totalEarnings: creator.totalEarnings,
          pendingBalance: creator.pendingBalance,
          paidOut,
        },
      };
    });
  }

  /**
   * Request creator completeness checklist
   */
  async getCreatorCompletenessChecklist(creatorId: string): Promise<any> {
    return this.executeWithLogging('payout.getCompletenessChecklist', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
        include: {
          user: {
            select: {
              verified: true,
            },
          },
        },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Get wallet info
      const wallet = await this.prisma.wallet.findFirst({
        where: {
          userId: creator.userId,
          verified: true,
        },
      });

      // Calculate completeness percentage
      let completeness = 0;
      const checklist: any[] = [];

      // Profile completeness
      if (creator.displayName) {
        completeness += 10;
        checklist.push({ item: 'Display name', completed: true });
      } else {
        checklist.push({ item: 'Display name', completed: false });
      }

      if (creator.bio) {
        completeness += 10;
        checklist.push({ item: 'Bio', completed: true });
      } else {
        checklist.push({ item: 'Bio', completed: false });
      }

      if (creator.avatar) {
        completeness += 10;
        checklist.push({ item: 'Avatar', completed: true });
      } else {
        checklist.push({ item: 'Avatar', completed: false });
      }

      if (creator.isPublic) {
        completeness += 10;
        checklist.push({ item: 'Profile public', completed: true });
      } else {
        checklist.push({ item: 'Profile public', completed: false });
      }

      if (creator.verified) {
        completeness += 15;
        checklist.push({ item: 'Creator verified', completed: true });
      } else {
        checklist.push({ item: 'Creator verified', completed: false });
      }

      if (creator.user?.verified) {
        completeness += 15;
        checklist.push({ item: 'Email verified', completed: true });
      } else {
        checklist.push({ item: 'Email verified', completed: false });
      }

      if (wallet) {
        completeness += 20;
        checklist.push({ item: 'Wallet linked', completed: true });
      } else {
        checklist.push({ item: 'Wallet linked', completed: false });
      }

      return {
        creatorId,
        completeness,
        checklist,
        recommendations: this.generateRecommendations(checklist),
      };
    });
  }

  private generateRecommendations(checklist: any[]): string[] {
    const recommendations: string[] = [];

    const incompleteItems = checklist.filter((item) => !item.completed);

    if (incompleteItems.length === 0) {
      recommendations.push('Your profile is complete! You are ready to receive tips.');
      return recommendations;
    }

    for (const item of incompleteItems) {
      switch (item.item) {
        case 'Display name':
          recommendations.push('Add a display name to make your profile more personal');
          break;
        case 'Bio':
          recommendations.push('Write a bio to tell fans about yourself');
          break;
        case 'Avatar':
          recommendations.push('Upload an avatar to make your profile recognizable');
          break;
        case 'Profile public':
          recommendations.push('Make your profile public so fans can find and support you');
          break;
        case 'Creator verified':
          recommendations.push('Get creator verification to build trust with your audience');
          break;
        case 'Email verified':
          recommendations.push('Verify your email to secure your account');
          break;
        case 'Wallet linked':
          recommendations.push('Link a Stellar wallet to receive tips and payouts');
          break;
      }
    }

    return recommendations;
  }
}
