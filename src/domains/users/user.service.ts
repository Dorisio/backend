import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import {
  ChangePasswordRequest,
  ChangePasswordResponse,
  PaginatedProfileChanges,
  ProfileChangeResponse,
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
import { comparePasswords, hashPassword } from '../../utils/password';
import { blacklistToken } from '../../utils/token-blacklist';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { storeAvatar } from './avatar.storage';

/** Columns exposed by the public user profile (never the password hash). */
const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  bio: true,
  avatar: true,
  role: true,
  verified: true,
  createdAt: true,
  updatedAt: true,
} as const;

const DEFAULT_SETTINGS = {
  notificationsEnabled: true,
  emailDigest: 'weekly',
} as const;

/** Fields whose changes are flagged as security sensitive in the audit trail. */
const SENSITIVE_AUDIT_FIELDS = new Set(['password', 'email', 'avatar']);

/** Request metadata captured alongside an audited change. */
export interface ProfileRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

interface ProfileChangeInput {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

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
    data: UpdateUserProfileRequest,
    context: ProfileRequestContext = {}
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateProfile', async () => {
      // Email is intentionally absent from the update schema; reject it
      // explicitly so a client cannot silently mutate the login identifier.
      if (Object.prototype.hasOwnProperty.call(data, 'email')) {
        throw new ValidationError(
          'Email cannot be changed here; use the email verification flow'
        );
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, bio: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const changes: ProfileChangeInput[] = [];
      if (data.name !== undefined && data.name !== user.name) {
        changes.push({ field: 'name', oldValue: user.name, newValue: data.name });
      }
      if (data.bio !== undefined && data.bio !== user.bio) {
        changes.push({ field: 'bio', oldValue: user.bio, newValue: data.bio });
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.bio !== undefined ? { bio: data.bio } : {}),
        },
        select: USER_PROFILE_SELECT,
      });

      if (changes.length > 0) {
        await this.recordProfileChanges(userId, changes, context);
      }

      const cacheKey = createCacheKey(CacheType.USER, userId);
      await update(cacheKey, this.formatUserProfile(updatedUser), CacheType.USER);
      // Settings are derived from the same row; drop the cached copy so the
      // next read re-evaluates against fresh data.
      await invalidate(createCacheKey(CacheType.USER, `${userId}:settings`));

      return this.formatUserProfile(updatedUser);
    });
  }

  /**
   * Change a password after verifying the current one. Distinct from the
   * forgot/reset flow: the caller proves ownership with the existing password.
   * The caller's access token is revoked so a leaked token cannot outlive the
   * rotation.
   */
  async changePassword(
    userId: string,
    data: ChangePasswordRequest,
    context: ProfileRequestContext = {},
    accessToken?: string
  ): Promise<ChangePasswordResponse> {
    return this.executeWithLogging('user.changePassword', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, password: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const currentPasswordMatches = await comparePasswords(data.currentPassword, user.password);
      if (!currentPasswordMatches) {
        throw new ValidationError('Current password is incorrect');
      }

      const hashedPassword = await hashPassword(data.newPassword);
      await this.prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Never store the password (or its hash) in the audit trail — only that
      // it changed, plus who/when/from where.
      await this.recordProfileChanges(
        userId,
        [{ field: 'password', oldValue: null, newValue: null }],
        context
      );

      logger.warn('Security-sensitive change: user password updated', {
        userId,
        ip: context.ip ?? undefined,
      });

      if (accessToken) {
        const expiresAt = new Date(Date.now() + parseExpiryToMs(config.JWT_EXPIRES_IN));
        await blacklistToken(accessToken, expiresAt);
      }

      await invalidate(createCacheKey(CacheType.USER, userId));

      return { success: true, message: 'Password updated successfully' };
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
            select: { id: true, notificationPreferences: true },
          });

          if (!user) {
            throw new NotFoundError('User');
          }

          return this.formatUserSettings(userId, user.notificationPreferences);
        },
      });
    });
  }

  async updateUserSettings(
    userId: string,
    data: UpdateUserSettingsRequest,
    context: ProfileRequestContext = {}
  ): Promise<UserSettingsResponse> {
    return this.executeWithLogging('user.updateSettings', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, notificationPreferences: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const current = this.formatUserSettings(userId, user.notificationPreferences);
      const updatedSettings: UserSettingsResponse = {
        userId,
        notificationsEnabled: data.notificationsEnabled ?? current.notificationsEnabled,
        emailDigest: data.emailDigest ?? current.emailDigest,
      };

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          notificationPreferences: {
            notificationsEnabled: updatedSettings.notificationsEnabled,
            emailDigest: updatedSettings.emailDigest,
          },
        },
      });

      const changes: ProfileChangeInput[] = [];
      if (updatedSettings.notificationsEnabled !== current.notificationsEnabled) {
        changes.push({
          field: 'notificationsEnabled',
          oldValue: String(current.notificationsEnabled),
          newValue: String(updatedSettings.notificationsEnabled),
        });
      }
      if (updatedSettings.emailDigest !== current.emailDigest) {
        changes.push({
          field: 'emailDigest',
          oldValue: current.emailDigest,
          newValue: updatedSettings.emailDigest,
        });
      }
      if (changes.length > 0) {
        await this.recordProfileChanges(userId, changes, context);
      }

      const cacheKey = createCacheKey(CacheType.USER, `${userId}:settings`);
      await update(cacheKey, updatedSettings, CacheType.USER);

      return updatedSettings;
    });
  }

  /**
   * Store an uploaded avatar and point the profile at it. The image is
   * validated (JPEG/PNG, <= 5MB) before anything is written.
   */
  async updateAvatar(
    userId: string,
    image: string,
    context: ProfileRequestContext = {}
  ): Promise<UserProfileResponse> {
    return this.executeWithLogging('user.updateAvatar', async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, avatar: true },
      });

      if (!user) {
        throw new NotFoundError('User');
      }

      const avatarUrl = await storeAvatar(userId, image);
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { avatar: avatarUrl },
        select: USER_PROFILE_SELECT,
      });

      await this.recordProfileChanges(
        userId,
        [{ field: 'avatar', oldValue: user.avatar, newValue: avatarUrl }],
        context
      );

      const cacheKey = createCacheKey(CacheType.USER, userId);
      await update(cacheKey, this.formatUserProfile(updatedUser), CacheType.USER);

      return this.formatUserProfile(updatedUser);
    });
  }

  /** Paginated audit trail for a user's profile changes, newest first. */
  async getProfileChanges(
    userId: string,
    page: number = 1,
    pageSize: number = 20
  ): Promise<PaginatedProfileChanges> {
    return this.executeWithLogging('user.getProfileChanges', async () => {
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, DEFAULT_PAGE_SIZE);
      const skip = (safePage - 1) * safePageSize;

      const [rows, total] = await Promise.all([
        this.prisma.profileChange.findMany({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: safePageSize,
        }),
        this.prisma.profileChange.count({ where: { userId } }),
      ]);

      const changes: ProfileChangeResponse[] = rows.map((row) => ({
        id: row.id,
        field: row.field,
        oldValue: row.oldValue,
        newValue: row.newValue,
        sensitive: row.sensitive,
        createdAt: row.createdAt.toISOString(),
      }));

      return {
        changes,
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages: Math.ceil(total / safePageSize),
      };
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

  /** Append one audit row per changed field, newest-first readable by userId. */
  private async recordProfileChanges(
    userId: string,
    changes: ProfileChangeInput[],
    context: ProfileRequestContext
  ): Promise<void> {
    if (changes.length === 0) return;

    await this.prisma.profileChange.createMany({
      data: changes.map((change) => ({
        userId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        sensitive: SENSITIVE_AUDIT_FIELDS.has(change.field),
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })),
    });
  }

  private formatUserSettings(userId: string, preferences: unknown): UserSettingsResponse {
    const stored =
      preferences !== null && typeof preferences === 'object'
        ? (preferences as Record<string, unknown>)
        : {};

    return {
      userId,
      notificationsEnabled:
        typeof stored.notificationsEnabled === 'boolean'
          ? stored.notificationsEnabled
          : DEFAULT_SETTINGS.notificationsEnabled,
      emailDigest:
        typeof stored.emailDigest === 'string' ? stored.emailDigest : DEFAULT_SETTINGS.emailDigest,
    };
  }

  private formatUserProfile(user: {
    id: string;
    email: string;
    name: string | null;
    bio: string | null;
    avatar: string | null;
    role: string;
    verified: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): UserProfileResponse {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      bio: user.bio,
      avatar: user.avatar,
      role: user.role,
      verified: user.verified,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }
}

/**
 * Parse an expiry string like "7d", "24h" or "3600" into milliseconds.
 * Mirrors the helper used by the auth service so token TTLs stay consistent.
 */
function parseExpiryToMs(expiryStr: string): number {
  const match = expiryStr.match(/^(\d+)([dhms]?)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = parseInt(match[1], 10);
  switch (match[2] || 's') {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    default:
      return value * 1000;
  }
}
