import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface LinkWalletRequest {
  publicKey: string;
  name?: string;
}

/** Hard cap on how many linked wallets a single read may return. */
const MAX_WALLETS_PER_USER = 20;

export class WalletService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async linkWallet(userId: string, data: LinkWalletRequest): Promise<{ id: string }> {
    return this.executeWithLogging('wallet.link', async () => {
      const existingWallet = await this.prisma.wallet.findUnique({
        where: { publicKey: data.publicKey },
      });

      if (existingWallet) {
        throw new ValidationError('Wallet already linked');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      const wallet = await this.prisma.wallet.create({
        data: {
          userId,
          publicKey: data.publicKey,
          name: data.name,
        },
      });

      logger.info(`Wallet linked for user ${userId}: ${data.publicKey}`);

      return { id: wallet.id };
    });
  }

  async getUserWallets(userId: string): Promise<any[]> {
    return this.executeWithLogging('wallet.getUserWallets', async () => {
      // Bounded + projected: a user can only have a handful of linked wallets,
      // but the cap keeps the read safe if that assumption ever breaks.
      const wallets = await this.prisma.wallet.findMany({
        where: { userId },
        select: {
          id: true,
          publicKey: true,
          name: true,
          verified: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_WALLETS_PER_USER,
      });

      return wallets;
    });
  }

  async unlinkWallet(walletId: string, userId: string): Promise<void> {
    return this.executeWithLogging('wallet.unlink', async () => {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId },
        select: { id: true, userId: true },
      });

      if (!wallet) {
        throw new ValidationError('Wallet not found');
      }

      if (wallet.userId !== userId) {
        throw new ValidationError('Unauthorized');
      }

      await this.prisma.wallet.delete({
        where: { id: walletId },
      });

      logger.info(`Wallet unlinked: ${walletId}`);
    });
  }

  async verifyWallet(walletId: string): Promise<void> {
    return this.executeWithLogging('wallet.verify', async () => {
      await this.prisma.wallet.update({
        where: { id: walletId },
        data: { verified: true },
      });

      logger.info(`Wallet verified: ${walletId}`);
    });
  }
}
