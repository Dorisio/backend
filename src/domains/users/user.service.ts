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
import { getOrFetch, invalidate, update, createCacheKey, CacheType } from '../../lib/cache/cache-aside';
import { DEFAULT_PAGE_SIZE, sanitizePageNumber, sanitizePageSize } from '../../utils/pagination';

/** Columns exposed by the public user profile (never the password hash). */
const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  verified: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class UserService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getUserProfile(userId: string): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.getProfile', async () => {
      const cacheKey = createCacheKey(CacheType.USER, userId);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.USER,
        fetchFn: async () => {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: USER_PROFILE_SELECT,
          });

          if (!user) {
            throw new NotFoundError('User');
          }

          return this.formatUserProfile(user);
        },
      });
    });
  }

  async updateUserProfile(
    userId: string,
    data: UpdateUserProfileRequest
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateProfile', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // Check if email is being changed and if it's unique
      if (data.email && data.email !== user.email) {
        const existingUser = await this.prisma.user.findUnique({
          where: { email: data.email },
          select: { id: true },
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
        select: USER_PROFILE_SELECT,
      });

      // Update cache
      const cacheKey = createCacheKey(CacheType.USER, userId);
      await update(cacheKey, this.formatUserProfile(updatedUser), CacheType.USER);
      // Settings cache is derived from the same row; drop it so the next read
      // re-evaluates against fresh data.
      await invalidate(createCacheKey(CacheType.USER, `${userId}:settings`));

      return this.formatUserProfile(updatedUser);
    });
  }

  async getUserSettings(userId: string): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.getSettings', async () => {
      const cacheKey = createCacheKey(CacheType.USER, `${userId}:settings`);

      return getOrFetch({
        key: cacheKey,
        type: CacheType.USER,
        fetchFn: async () => {
          const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
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
        },
      });
    });
  }

  async updateUserSettings(
    userId: string,
    data: UpdateUserSettingsRequest
  ): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.updateSettings', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      // For now, return updated settings (can be extended to database storage)
      const updatedSettings = {
        userId,
        notificationsEnabled: data.notificationsEnabled ?? true,
        emailDigest: data.emailDigest ?? 'weekly',
      };

      // Update cache
      const cacheKey = createCacheKey(CacheType.USER, `${userId}:settings`);
      await update(cacheKey, updatedSettings, CacheType.USER);

      return updatedSettings;
    });
  }

  async getUserTransactionHistory(
    userId: string,
    page: number = 1,
    pageSize: number = 20
  ): Promise<PaginatedTransactions> {
    return this.executeWithLogging('user.getTransactionHistory', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const skip = (safePage - 1) * safePageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where: {
            fromUserId: userId,
          },
          select: {
            id: true,
            amount: true,
            status: true,
            creatorId: true,
            message: true,
            createdAt: true,
            creator: {
              select: {
                id: true,
                displayName: true,
              },
            },
          },
          skip,
          take: safePageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

      const totalPages = Math.ceil(total / safePageSize);

      return {
        transactions,
        items: transactions,
        data: transactions,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
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
