import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import {
  CreateTipRequest,
  UpdateTipStatusRequest,
  TipResponse,
  TipStatus,
  BuildTransactionResponse,
  SubmitTransactionResponse,
} from './payment.types';
import { ValidationError, NotFoundError, UnauthorizedError } from '../../utils/errors';
import {
  buildPaymentTransaction,
  submitSignedTransaction,
  checkTransactionStatus,
} from '../../lib/stellar/transactions';
import { logger } from '../../utils/logger';
import { stellarConfirmationQueue } from '../../lib/queue';

export class PaymentService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Create a new tip (initial step before payment transaction)
   * Validates:
   * - Amount is positive
   * - Creator exists and is public and verified
   * - Sender has a verified wallet
   */
  async createTip(userId: string, data: CreateTipRequest): Promise<TipResponse> {
    return this.executeWithLogging('payment.createTip', async () => {
      // Validate amount
      if (data.amount <= 0) {
        throw new ValidationError('Amount must be greater than 0');
      }

      // Verify creator exists, is public, and is verified
      const creator = await this.prisma.creator.findUnique({
        where: { id: data.creatorId },
        include: { user: true },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      if (!creator.isPublic) {
        throw new ValidationError('Creator is not available for tips');
      }

      if (!creator.verified) {
        throw new ValidationError('Creator account must be verified to receive tips');
      }

      // Verify sender is not tipping themselves
      const sender = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!sender) {
        throw new NotFoundError('User');
      }

      if (creator.userId === userId) {
        throw new ValidationError('Cannot tip yourself');
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

      // Create tip in pending state
      const tip = await this.prisma.tip.create({
        data: {
          fromUserId: userId,
          creatorId: data.creatorId,
          amount: data.amount,
          message: data.message || null,
          status: TipStatus.PENDING,
        },
      });

      logger.info(`Tip created: ${tip.id} from ${userId} to ${data.creatorId} for ${data.amount}`);
      return this.formatTipResponse(tip);
    });
  }

  /**
   * Get a specific tip by ID
   */
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

  /**
   * List tips received by a creator with pagination
   */
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

      // Validate pagination
      if (page < 1 || pageSize < 1 || pageSize > 100) {
        throw new ValidationError('Invalid pagination parameters');
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

  /**
   * Get tip history for a user (tips they sent)
   */
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
      // Validate pagination
      if (page < 1 || pageSize < 1 || pageSize > 100) {
        throw new ValidationError('Invalid pagination parameters');
      }

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

  /**
   * List tips for a creator using cursor-based keyset pagination
   */
  async listTipsCursor(
    creatorId: string,
    params: { first?: number; after?: string; last?: number; before?: string } = {}
  ): Promise<{
    edges: Array<{ node: TipResponse; cursor: string }>;
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
      totalCount?: number;
    };
    total?: number;
  }> {
    return this.executeWithLogging('payment.listTipsCursor', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      const limit = params.first ?? params.last ?? 20;
      if (limit < 1 || limit > 100) {
        throw new ValidationError('Limit must be between 1 and 100');
      }

      let cursorObj: { id: string; createdAt: string } | undefined;
      if (params.after) {
        try {
          const json = Buffer.from(params.after, 'base64url').toString('utf8');
          cursorObj = JSON.parse(json);
        } catch {
          throw new ValidationError('Invalid pagination cursor');
        }
      }

      const tips = await this.prisma.tip.findMany({
        where: {
          creatorId,
        },
        take: limit + 1,
        ...(cursorObj ? { cursor: { id: cursorObj.id }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      const hasMore = tips.length > limit;
      const nodes = hasMore ? tips.slice(0, limit) : tips;

      const edges = nodes.map((tip) => ({
        node: this.formatTipResponse(tip),
        cursor: Buffer.from(
          JSON.stringify({ id: tip.id, createdAt: tip.createdAt.toISOString() }),
          'utf8'
        ).toString('base64url'),
      }));

      const startCursor = edges.length > 0 ? edges[0].cursor : null;
      const endCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

      return {
        edges,
        pageInfo: {
          hasNextPage: hasMore,
          hasPreviousPage: Boolean(params.after),
          startCursor,
          endCursor,
        },
      };
    });
  }

  /**
   * List user tip history using cursor-based keyset pagination
   */
  async getUserTipHistoryCursor(
    userId: string,
    params: { first?: number; after?: string; last?: number; before?: string } = {}
  ): Promise<{
    edges: Array<{ node: TipResponse; cursor: string }>;
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    };
  }> {
    return this.executeWithLogging('payment.getUserTipHistoryCursor', async () => {
      const limit = params.first ?? params.last ?? 20;
      if (limit < 1 || limit > 100) {
        throw new ValidationError('Limit must be between 1 and 100');
      }

      let cursorObj: { id: string; createdAt: string } | undefined;
      if (params.after) {
        try {
          const json = Buffer.from(params.after, 'base64url').toString('utf8');
          cursorObj = JSON.parse(json);
        } catch {
          throw new ValidationError('Invalid pagination cursor');
        }
      }

      const tips = await this.prisma.tip.findMany({
        where: {
          fromUserId: userId,
        },
        take: limit + 1,
        ...(cursorObj ? { cursor: { id: cursorObj.id }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      const hasMore = tips.length > limit;
      const nodes = hasMore ? tips.slice(0, limit) : tips;

      const edges = nodes.map((tip) => ({
        node: this.formatTipResponse(tip),
        cursor: Buffer.from(
          JSON.stringify({ id: tip.id, createdAt: tip.createdAt.toISOString() }),
          'utf8'
        ).toString('base64url'),
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage: hasMore,
          hasPreviousPage: Boolean(params.after),
          startCursor: edges.length > 0 ? edges[0].cursor : null,
          endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
        },
      };
    });
  }

  /**
   * Update tip status (typically used by transaction listener/confirmation service)
   * Can only update to specific statuses based on current state
   */
  async updateTipStatus(tipId: string, data: UpdateTipStatusRequest): Promise<TipResponse> {
    return this.executeWithLogging('payment.updateTipStatus', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      // Validate status transition
      const validTransitions: Record<string, string[]> = {
        [TipStatus.PENDING]: [TipStatus.COMPLETED, TipStatus.FAILED, TipStatus.CANCELLED],
        [TipStatus.COMPLETED]: [],
        [TipStatus.FAILED]: [TipStatus.PENDING], // Allow retry
        [TipStatus.CANCELLED]: [],
      };

      if (!validTransitions[tip.status].includes(data.status)) {
        throw new ValidationError(`Cannot transition from ${tip.status} to ${data.status}`);
      }

      const updatedTip = await this.prisma.tip.update({
        where: { id: tipId },
        data: {
          status: data.status,
        },
      });

      // If tip is newly completed, update creator's earnings
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

        logger.info(`Tip completed and creator earnings updated: ${tipId}, amount: ${tip.amount}`);
      }

      return this.formatTipResponse(updatedTip);
    });
  }

  /**
   * Build a Stellar payment transaction for frontend signing
   * Frontend will sign this transaction with user's wallet and submit it back
   */
  async buildPaymentTransaction(
    tipId: string,
    senderPublicKey: string,
    creatorPublicKey: string,
    amount: string,
    assetCode?: string,
    assetIssuer?: string
  ): Promise<BuildTransactionResponse> {
    return this.executeWithLogging('payment.buildTransaction', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      if (tip.status !== TipStatus.PENDING) {
        throw new ValidationError('Can only build transaction for pending tips');
      }

      // Verify sender wallet exists and matches tip sender
      const sender = await this.prisma.wallet.findFirst({
        where: {
          publicKey: senderPublicKey,
          verified: true,
        },
      });

      if (!sender || sender.userId !== tip.fromUserId) {
        throw new UnauthorizedError('Wallet does not match tip sender');
      }

      try {
        // Build transaction
        const transactionBuilder = await buildPaymentTransaction({
          senderPublicKey,
          recipientPublicKey: creatorPublicKey,
          amount,
          assetCode,
          assetIssuer,
          memo: `tip-${tipId}`,
        });

        const transaction = transactionBuilder.build();
        const transactionEnvelope = transaction.toEnvelope().toXDR();

        logger.debug(`Payment transaction built for tip: ${tipId}`);

        return {
          transactionEnvelope: transactionEnvelope as any as string,
          tipId,
          fee: 100, // Base fee in stroops
        };
      } catch (error) {
        logger.error(`Failed to build transaction for tip ${tipId}:`, error);
        throw new ValidationError('Failed to build payment transaction');
      }
    });
  }

  /**
   * Submit a signed payment transaction
   * Stores the transaction hash and updates tip status
   */
  async submitPaymentTransaction(
    tipId: string,
    transactionEnvelope: string
  ): Promise<SubmitTransactionResponse> {
    return this.executeWithLogging('payment.submitTransaction', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      if (tip.status !== TipStatus.PENDING) {
        throw new ValidationError('Can only submit transaction for pending tips');
      }

      try {
        // Submit transaction to Stellar network
        const result = await submitSignedTransaction(transactionEnvelope);

        // Store transaction hash in tip
        const updatedTip = await this.prisma.tip.update({
          where: { id: tipId },
          data: {
            transactionHash: result.transactionHash,
          },
        });

        logger.info(
          `Payment transaction submitted for tip: ${tipId}, hash: ${result.transactionHash}`
        );

        return {
          tipId,
          transactionHash: result.transactionHash,
          status: updatedTip.status as TipResponse['status'],
        };
      } catch (error) {
        logger.error(`Failed to submit transaction for tip ${tipId}:`, error);
        throw new ValidationError('Failed to submit payment transaction');
      }
    });
  }

  /**
   * Check and update transaction confirmation status
   * Called to verify if a submitted transaction has been confirmed on the network
   */
  async checkTransactionConfirmation(tipId: string): Promise<TipResponse> {
    return this.executeWithLogging('payment.checkConfirmation', async () => {
      const tip = await this.prisma.tip.findUnique({
        where: { id: tipId },
      });

      if (!tip) {
        throw new NotFoundError('Tip');
      }

      if (!tip.transactionHash) {
        throw new ValidationError('No transaction hash found for this tip');
      }

      // Queue the Stellar confirmation check as async job instead of blocking
      await stellarConfirmationQueue.add(
        'confirm-transaction',
        {
          transactionId: tipId,
          transactionHash: tip.transactionHash,
        },
        {
          attempts: 60,
          backoff: { type: 'exponential', delay: 1000 },
        }
      );

      logger.info(`Queued Stellar confirmation check for tip ${tipId}`);

      // Return current tip status immediately (job runs in background)
      return this.formatTipResponse(tip);
    });
  }

  /**
   * Format database tip record to response DTO
   */
  private formatTipResponse(tip: any): TipResponse {
    return {
      id: tip.id,
      fromUserId: tip.fromUserId,
      creatorId: tip.creatorId,
      amount: tip.amount,
      message: tip.message,
      status: tip.status as TipResponse['status'],
      transactionHash: tip.transactionHash || null,
      createdAt: tip.createdAt.toISOString(),
      updatedAt: tip.updatedAt.toISOString(),
    };
  }
}
