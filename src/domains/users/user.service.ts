import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import {
  UpdateUserProfileRequest,
  UpdateUserSettingsRequest,
  UserProfileResponse,
  UserSettingsResponse,
  UserTransactionHistoryResponse,
  PaginatedTransactions,
} from './user.types';
import { ValidationError, NotFoundError } from '../../utils/errors';

export class UserService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.getProfile', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      return this.formatUserProfile(user);
    });
  }

  async updateUserProfile(
    userId: string,
    data: UpdateUserProfileRequest
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateProfile', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // Check if email is being changed and if it's unique
      if (data.email && data.email !== user.email) {
        const existingUser = await this.prisma.user.findUnique({
          where: { email: data.email },
        });

        if (existingUser) {
          throw new ValidationError('Email already in use');
        }
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: {
          name: data.name ?? user.name,
          email: data.email ?? user.email,
        },
      });

      return this.formatUserProfile(updatedUser);
    });
  }

  async getUserSettings(userId: string): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.getSettings', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // For now, return default settings (can be extended to database storage)
      return {
        userId,
        notificationsEnabled: true,
        emailDigest: 'weekly',
      };
    });
  }

  async updateUserSettings(
    userId: string,
    data: UpdateUserSettingsRequest
  ): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.updateSettings', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // For now, return updated settings (can be extended to database storage)
      return {
        userId,
        notificationsEnabled: data.notificationsEnabled ?? true,
        emailDigest: data.emailDigest ?? 'weekly',
      };
    });
  }

  async getUserTransactionHistory(
    userId: string,
    page: number = 1,
    pageSize: number = 10
  ): Promise<PaginatedTransactions> {
    return this.executeWithLogging('user.getTransactionHistory', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const skip = (page - 1) * pageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where: {
            fromUserId: userId,
          },
          include: {
            creator: {
              select: {
                id: true,
                displayName: true,
              },
            },
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

      const transactions: UserTransactionHistoryResponse[] = tips.map((tip) => ({
        id: tip.id,
        amount: tip.amount,
        status: tip.status,
        creatorId: tip.creatorId,
        creatorName: tip.creator?.displayName || 'Unknown Creator',
        message: tip.message,
        createdAt: tip.createdAt.toISOString(),
      }));

      return {
        transactions,
        total,
        page,
        pageSize,
      };
    });
  }

  private formatUserProfile(user: any): UserProfileResponse {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      verified: user.verified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }
}
