import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ValidationError, NotFoundError, UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface FlagWalletRequest {
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  notes?: string;
}

export interface FreezeAccountRequest {
  reason: string;
  duration?: number; // In hours, null = indefinite
  notes?: string;
}

export class AdminService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Check if user is admin
   */
  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'ADMIN';
  }

  /**
   * Flag a wallet as suspicious
   */
  async flagWallet(
    adminUserId: string,
    walletAddress: string,
    data: FlagWalletRequest
  ): Promise<{
    id: string;
    walletAddress: string;
    flaggedAt: string;
    reason: string;
    severity: string;
  }> {
    return this.executeWithLogging('admin.flagWallet', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can flag wallets');
      }

      // Create wallet flag
      const flag = await this.prisma.walletFlag.create({
        data: {
          address: walletAddress,
          reason: data.reason,
          severity: data.severity,
          notes: data.notes,
          flaggedBy: adminUserId,
        },
      });

      logger.warn(`Wallet flagged by admin: ${walletAddress} (severity: ${data.severity})`);

      return {
        id: flag.id,
        walletAddress,
        flaggedAt: flag.createdAt.toISOString(),
        reason: flag.reason,
        severity: flag.severity,
      };
    });
  }

  /**
   * Unflag a wallet
   */
  async unflagWallet(adminUserId: string, flagId: string): Promise<void> {
    return this.executeWithLogging('admin.unflagWallet', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can unflag wallets');
      }

      const flag = await this.prisma.walletFlag.findUnique({
        where: { id: flagId },
      });

      if (!flag) {
        throw new NotFoundError('Wallet flag');
      }

      await this.prisma.walletFlag.delete({
        where: { id: flagId },
      });

      logger.info(`Wallet flag resolved by admin: ${flagId}`);
    });
  }

  /**
   * Freeze a creator account pending review
   */
  async freezeAccount(
    adminUserId: string,
    creatorId: string,
    data: FreezeAccountRequest
  ): Promise<{
    id: string;
    creatorId: string;
    frozenAt: string;
    reason: string;
    expiresAt?: string;
  }> {
    return this.executeWithLogging('admin.freezeAccount', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can freeze accounts');
      }

      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      // Calculate expiration time if duration provided
      let expiresAt = null;
      if (data.duration) {
        expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + data.duration);
      }

      // Create freeze record
      const freeze = await this.prisma.accountFreeze.create({
        data: {
          creatorId,
          reason: data.reason,
          duration: data.duration || null,
          expiresAt,
          notes: data.notes,
          frozenBy: adminUserId,
        },
      });

      logger.warn(`Creator account frozen by admin: ${creatorId} (reason: ${data.reason})`);

      return {
        id: freeze.id,
        creatorId,
        frozenAt: freeze.createdAt.toISOString(),
        reason: freeze.reason,
        expiresAt: expiresAt?.toISOString(),
      };
    });
  }

  /**
   * Unfreeze a creator account
   */
  async unfreezeAccount(adminUserId: string, freezeId: string): Promise<void> {
    return this.executeWithLogging('admin.unfreezeAccount', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can unfreeze accounts');
      }

      const freeze = await this.prisma.accountFreeze.findUnique({
        where: { id: freezeId },
      });

      if (!freeze) {
        throw new NotFoundError('Account freeze');
      }

      await this.prisma.accountFreeze.delete({
        where: { id: freezeId },
      });

      logger.info(`Creator account unfrozen by admin: ${freeze.creatorId}`);
    });
  }

  /**
   * Get moderation queue - flagged wallets and frozen accounts with pagination
   */
  async getModerationQueue(
    page: number = 1,
    pageSize: number = 20
  ): Promise<{
    flaggedWallets: {
      id: string;
      address: string;
      severity: string;
      reason: string;
      flaggedAt: string;
    }[];
    frozenAccounts: {
      id: string;
      creatorId: string;
      reason: string;
      frozenAt: string;
      expiresAt?: string;
    }[];
    totalWallets: number;
    totalFreezes: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    return this.executeWithLogging('admin.moderationQueue', async () => {
      const { sanitizePageNumber, sanitizePageSize } = await import('../../utils/pagination');

      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, 20);
      const skip = (safePage - 1) * safePageSize;

      const [flaggedWallets, totalWallets, frozenAccounts, totalFreezes] = await Promise.all([
        this.prisma.walletFlag.findMany({
          where: { resolved: false },
          orderBy: { createdAt: 'desc' },
          skip,
          take: safePageSize,
        }),
        this.prisma.walletFlag.count({ where: { resolved: false } }),
        this.prisma.accountFreeze.findMany({
          where: { resolved: false },
          orderBy: { createdAt: 'desc' },
          skip,
          take: safePageSize,
        }),
        this.prisma.accountFreeze.count({ where: { resolved: false } }),
      ]);

      const maxTotal = Math.max(totalWallets, totalFreezes);
      const totalPages = Math.ceil(maxTotal / safePageSize) || 1;

      return {
        flaggedWallets: flaggedWallets.map((f) => ({
          id: f.id,
          address: f.address,
          severity: f.severity,
          reason: f.reason,
          flaggedAt: f.createdAt.toISOString(),
        })),
        frozenAccounts: frozenAccounts.map((f) => ({
          id: f.id,
          creatorId: f.creatorId,
          reason: f.reason,
          frozenAt: f.createdAt.toISOString(),
          expiresAt: f.expiresAt?.toISOString(),
        })),
        totalWallets,
        totalFreezes,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  /**
   * Check if wallet is flagged (used for payment validation)
   */
  async isWalletFlagged(walletAddress: string): Promise<boolean> {
    const flag = await this.prisma.walletFlag.findFirst({
      where: {
        address: walletAddress,
        resolved: false,
      },
    });
    return !!flag;
  }

  /**
   * Check if creator account is frozen (used for payment validation)
   */
  async isAccountFrozen(creatorId: string): Promise<boolean> {
    const freeze = await this.prisma.accountFreeze.findFirst({
      where: {
        creatorId,
        resolved: false,
      },
    });

    // Check if freeze has expired
    if (freeze && freeze.expiresAt && freeze.expiresAt < new Date()) {
      // Auto-resolve expired freeze
      await this.prisma.accountFreeze.update({
        where: { id: freeze.id },
        data: { resolved: true, resolvedAt: new Date() },
      });
      return false;
    }

    return !!freeze;
  }
}
