import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { CreateTipRequest, UpdateTipStatusRequest, TipResponse, TipStatus } from './payment.types';
import { ValidationError, NotFoundError } from '../../utils/errors';

export class PaymentService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async createTip(userId: string, data: CreateTipRequest): Promise<TipResponse> {
    return this.executeWithLogging('payment.createTip', async () => {
      // Validate amount
      if (data.amount <= 0) {
        throw new ValidationError('Amount must be greater than 0');
      }

      // Verify creator exists and is public
      const creator = await this.prisma.creator.findUnique({
        where: { id: data.creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      if (!creator.isPublic) {
        throw new ValidationError('Creator is not available for tips');
      }

      // Verify sender wallet is verified
      const wallet = await this.prisma.wallet.findFirst({
        where: {
          userId,
          verified: true,
        },
      });

      if (!wallet) {
        throw new ValidationError('User does not have a verified wallet');
      }

      // Create tip
      const tip = await this.prisma.tip.create({
        data: {
          fromUserId: userId,
          creatorId: data.creatorId,
          amount: data.amount,
          message: data.message || null,
          status: TipStatus.PENDING,
        },
      });

      return this.formatTipResponse(tip);
    });
  }

  async getTip(tipId: string): Promise<TipResponse> {
    return this.executeWithLogging('payment.getTip', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      return this.formatTipResponse(tip);
    });
  }

  async listTips(
    creatorId: string,
    page: number = 1,
    pageSize: number = 10
  ): Promise<{
    tips: TipResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.executeWithLogging('payment.listTips', async () => {
      // Verify creator exists
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      const skip = (page - 1) * pageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where: {
            creatorId,
          },
          skip,
          take: pageSize,
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.tip.count({
          where: {
            creatorId,
          },
        }),
      ]);

      return {
        tips: tips.map((tip) => this.formatTipResponse(tip)),
        total,
        page,
        pageSize,
      };
    });
  }

  async getUserTipHistory(
    userId: string,
    page: number = 1,
    pageSize: number = 10
  ): Promise<{
    tips: TipResponse[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.executeWithLogging('payment.getUserTipHistory', async () => {
      const skip = (page - 1) * pageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where: {
            fromUserId: userId,
          },
          skip,
          take: pageSize,
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.tip.count({
          where: {
            fromUserId: userId,
          },
        }),
      ]);

      return {
        tips: tips.map((tip) => this.formatTipResponse(tip)),
        total,
        page,
        pageSize,
      };
    });
  }

  async updateTipStatus(tipId: string, data: UpdateTipStatusRequest): Promise<TipResponse> {
    return this.executeWithLogging('payment.updateTipStatus', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      const updatedTip = await this.prisma.tip.update({
        where: { id: tipId },
        data: {
          status: data.status,
        },
      });

      // If tip is completed, update creator's earnings
      if (data.status === TipStatus.COMPLETED && tip.status !== TipStatus.COMPLETED) {
        await this.prisma.creator.update({
          where: { id: tip.creatorId },
          data: {
            totalEarnings: {
              increment: tip.amount,
            },
            pendingBalance: {
              increment: tip.amount,
            },
          },
        });
      }

      return this.formatTipResponse(updatedTip);
    });
  }

  private formatTipResponse(tip: any): TipResponse {
    return {
      id: tip.id,
      fromUserId: tip.fromUserId,
      creatorId: tip.creatorId,
      amount: tip.amount,
      message: tip.message,
      status: tip.status as TipResponse['status'],
      createdAt: tip.createdAt.toISOString(),
      updatedAt: tip.updatedAt.toISOString(),
    };
  }
}
