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
import {
  sanitizePageSize,
  sanitizePageNumber,
  parseSortParameters,
} from '../../utils/pagination';
import { paginateWithCursor } from '../../db/pagination';
import { buildTipMemo, validateMemo, validatePaymentAmount } from '../../lib/stellar/validation';

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
      // Validate amount at the service boundary as well, so callers that bypass
      // the route layer (jobs, internal tooling) cannot create bad records.
      const amountCheck = validatePaymentAmount(data.amount);
      if (!amountCheck.valid) {
        throw new ValidationError(amountCheck.reason || 'Amount must be greater than 0');
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
   * List tips received by a creator with offset pagination, multi-column sorting, and filtering
   */
  async listTips(
    creatorId: string,
    page: number = 1,
    pageSize: number = 20,
    options: {
      status?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{
    tips: TipResponse[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
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
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, 20);

      const where: any = { creatorId };
      if (options.status) {
        where.status = options.status;
      }

      const sortFields = parseSortParameters(
        options.sortBy,
        options.sortOrder,
        ['createdAt', 'amount', 'status', 'id', 'updatedAt'],
        'createdAt',
        'desc'
      );

      const orderBy = sortFields.map((s) => ({ [s.field]: s.direction }));
      const skip = (safePage - 1) * safePageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where,
          skip,
          take: safePageSize,
          orderBy,
        }),
        this.prisma.tip.count({ where }),
      ]);

      const totalPages = Math.ceil(total / safePageSize);

      return {
        tips: tips.map((tip) => this.formatTipResponse(tip)),
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  /**
   * List tips received by a creator with cursor-based pagination
   */
  async listTipsCursor(
    creatorId: string,
    params: {
      limit?: number;
      cursor?: string;
      after?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
    } = {}
  ) {
    return this.executeWithLogging('payment.listTipsCursor', async () => {
      const creator = await this.prisma.creator.findUnique({
        where: { id: creatorId },
      });

      if (!creator) {
        throw new NotFoundError('Creator');
      }

      const where: any = { creatorId };
      if (params.status) {
        where.status = params.status;
      }

      const result = await paginateWithCursor(
        this.prisma.tip,
        {
          limit: params.limit,
          after: params.after || params.cursor,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
        },
        {
          where,
          allowedSortFields: ['createdAt', 'amount', 'status', 'id', 'updatedAt'],
          defaultSortField: 'createdAt',
          defaultSortDirection: 'desc',
        }
      );

      return {
        ...result,
        items: result.items.map((tip) => this.formatTipResponse(tip)),
        data: result.data.map((tip) => this.formatTipResponse(tip)),
      };
    });
  }

  /**
   * Get tip history for a user (tips they sent) with offset pagination, sorting, and filtering
   */
  async getUserTipHistory(
    userId: string,
    page: number = 1,
    pageSize: number = 20,
    options: {
      status?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{
    tips: TipResponse[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    return this.executeWithLogging('payment.getUserTipHistory', async () => {
      // Validate pagination
      const safePage = sanitizePageNumber(page);
      const safePageSize = sanitizePageSize(pageSize, 20);

      const where: any = { fromUserId: userId };
      if (options.status) {
        where.status = options.status;
      }

      const sortFields = parseSortParameters(
        options.sortBy,
        options.sortOrder,
        ['createdAt', 'amount', 'status', 'id', 'updatedAt'],
        'createdAt',
        'desc'
      );

      const orderBy = sortFields.map((s) => ({ [s.field]: s.direction }));
      const skip = (safePage - 1) * safePageSize;

      const [tips, total] = await Promise.all([
        this.prisma.tip.findMany({
          where,
          skip,
          take: safePageSize,
          orderBy,
        }),
        this.prisma.tip.count({ where }),
      ]);

      const totalPages = Math.ceil(total / safePageSize);

      return {
        tips: tips.map((tip) => this.formatTipResponse(tip)),
        total,
        page: safePage,
        pageSize: safePageSize,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrev: safePage > 1,
      };
    });
  }

  /**
   * Get tip history for a user with cursor pagination
   */
  async getUserTipHistoryCursor(
    userId: string,
    params: {
      limit?: number;
      cursor?: string;
      after?: string;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
    } = {}
  ) {
    return this.executeWithLogging('payment.getUserTipHistoryCursor', async () => {
      const where: any = { fromUserId: userId };
      if (params.status) {
        where.status = params.status;
      }

      const result = await paginateWithCursor(
        this.prisma.tip,
        {
          limit: params.limit,
          after: params.after || params.cursor,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
        },
        {
          where,
          allowedSortFields: ['createdAt', 'amount', 'status', 'id', 'updatedAt'],
          defaultSortField: 'createdAt',
          defaultSortDirection: 'desc',
        }
      );

      return {
        ...result,
        items: result.items.map((tip) => this.formatTipResponse(tip)),
        data: result.data.map((tip) => this.formatTipResponse(tip)),
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
      return this.prisma.$transaction(async (tx) => {
        const tip = await tx.tip.findUnique({ where: { id: tipId } });
        if (!tip) throw new NotFoundError('Tip');

        const validTransitions: Record<string, string[]> = {
          [TipStatus.PENDING]: [TipStatus.COMPLETED, TipStatus.FAILED, TipStatus.CANCELLED],
          [TipStatus.COMPLETED]: [],
          [TipStatus.FAILED]: [TipStatus.PENDING],
          [TipStatus.CANCELLED]: [],
        };
        if (!validTransitions[tip.status]?.includes(data.status)) {
          throw new ValidationError(`Cannot transition from ${tip.status} to ${data.status}`);
        }

        const changed = await tx.tip.updateMany({
          where: { id: tipId, status: tip.status },
          data: { status: data.status },
        });
        if (changed.count !== 1) {
          throw new ValidationError('Tip status changed concurrently; reload and retry');
        }

        if (data.status === TipStatus.COMPLETED && tip.status !== TipStatus.COMPLETED) {
          await tx.creator.update({
            where: { id: tip.creatorId },
            data: {
              totalEarnings: { increment: tip.amount },
              pendingBalance: { increment: tip.amount },
            },
          });
          logger.info(`Tip completed and creator earnings updated: ${tipId}, amount: ${tip.amount}`);
        }

        return this.formatTipResponse({ ...tip, status: data.status });
      });
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

      // Stellar memos are capped at 28 bytes. Build (and verify) the memo before
      // touching the network so we fail fast with a clear error.
      const memo = buildTipMemo(tipId);
      const memoCheck = validateMemo(memo);
      if (!memoCheck.valid) {
        throw new ValidationError(memoCheck.reason || 'Invalid transaction memo');
      }

      try {
        // Build transaction
        const transactionBuilder = await buildPaymentTransaction({
          senderPublicKey,
          recipientPublicKey: creatorPublicKey,
          amount,
          assetCode,
          assetIssuer,
          memo,
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
