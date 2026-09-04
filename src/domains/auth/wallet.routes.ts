import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import {
  generateWalletNonce,
  getWalletChallenge,
  verifyAndLinkWallet,
  getUserWallets,
  unlinkWallet,
  getWalletBalance,
  updateWalletName,
} from '../../lib/stellar/wallet';
import { ValidationError, AppError, UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * Zod schema for generating wallet nonce
 */
const GenerateNonceSchema = z.object({
  publicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
});

/**
 * Zod schema for verifying wallet with signed challenge
 */
const VerifyWalletSchema = z.object({
  publicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
  nonce: z.string().min(32, 'Invalid nonce format'),
  signedTransaction: z.string().min(1, 'Signed transaction is required'),
});

/**
 * Zod schema for unlinking wallet
 */
const UnlinkWalletSchema = z.object({
  walletId: z.string().cuid('Invalid wallet ID format'),
});

/**
 * Zod schema for updating wallet name
 */
const UpdateWalletNameSchema = z.object({
  name: z.string().max(100, 'Wallet name must be 100 characters or less'),
});

export const registerWalletRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  /**
   * POST /api/v1/wallet/nonce
   * Generate a nonce for wallet verification challenge
   * User will use this nonce with their Freighter wallet
   *
   * Requires: authenticated user
   * Body: { publicKey: string }
   * Returns: { nonce: string, expiresIn: number (seconds) }
   */
  app.post<{ Body: any }>(
    '/api/v1/wallet/nonce',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        const body = GenerateNonceSchema.parse(request.body);

        logger.debug(
          `Generating nonce for wallet verification: ${body.publicKey} (user: ${user.userId})`
        );

        const nonce = await generateWalletNonce(body.publicKey);

        reply.code(201).send(
          formatSuccess({
            nonce,
            expiresIn: 600, // 10 minutes (config.WALLET_NONCE_EXPIRY)
            message: 'Sign this nonce with your Freighter wallet to verify ownership',
          })
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message, 'VALIDATION_ERROR'));
        } else if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'NONCE_GENERATION_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * GET /api/v1/wallet/challenge/:nonce
   * Get challenge transaction to sign with Freighter wallet
   * This transaction must be signed and sent back to /wallet/verify
   *
   * Public endpoint (no auth required)
   * Params: nonce from /wallet/nonce
   * Returns: { challenge: string (transaction XDR) }
   */
  app.get<{ Params: { nonce: string } }>(
    '/api/v1/wallet/challenge/:nonce',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { nonce } = request.params;

        logger.debug(`Retrieving challenge transaction for nonce: ${nonce.substring(0, 8)}...`);

        const challengeTransaction = await getWalletChallenge(nonce);

        reply.send(
          formatSuccess({
            challenge: challengeTransaction,
            instructions:
              'Sign this transaction with your Freighter wallet, then submit the signed transaction to /wallet/verify',
          })
        );
      } catch (error) {
        if (error instanceof Error) {
          const statusCode = error.message.includes('expired') ? 410 : 400;
          reply.code(statusCode).send(
            formatError(error.message, statusCode === 410 ? 'NONCE_EXPIRED' : 'CHALLENGE_ERROR')
          );
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * POST /api/v1/wallet/verify
   * Verify signed challenge and link wallet to user account
   * Completes the wallet verification flow
   *
   * Requires: authenticated user
   * Body: { publicKey: string, nonce: string, signedTransaction: string }
   * Returns: { id: string, publicKey: string, verified: boolean }
   */
  app.post<{ Body: any }>(
    '/api/v1/wallet/verify',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        const body = VerifyWalletSchema.parse(request.body);

        logger.debug(
          `Verifying wallet: ${body.publicKey} for user: ${user.userId}`
        );

        const result = await verifyAndLinkWallet(
          prisma,
          user.userId,
          body.publicKey,
          body.nonce,
          body.signedTransaction
        );

        reply.code(201).send(
          formatSuccess({
            ...result,
            message: 'Wallet successfully verified and linked',
          })
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message, 'VALIDATION_ERROR'));
        } else if (error instanceof Error) {
          const statusCode = error.message.includes('already linked') ? 409 : 400;
          reply.code(statusCode).send(
            formatError(error.message, 'WALLET_VERIFICATION_FAILED')
          );
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * GET /api/v1/wallet/list
   * Get all verified wallets for authenticated user
   * Optionally include current balances
   *
   * Requires: authenticated user
   * Query params: includeBalance? (true/false, default false)
   * Returns: { wallets: Wallet[] }
   */
  app.get<{ Querystring: { includeBalance?: string } }>(
    '/api/v1/wallet/list',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        logger.debug(`Fetching wallets for user: ${user.userId}`);

        const wallets = await getUserWallets(prisma, user.userId);
        const includeBalance = request.query.includeBalance === 'true';

        let walletsWithBalance = wallets;

        if (includeBalance) {
          logger.debug(
            `Including balance information for ${wallets.length} wallets`
          );

          walletsWithBalance = await Promise.all(
            wallets.map(async (wallet) => {
              try {
                const balance = await getWalletBalance(wallet.publicKey);
                return {
                  ...wallet,
                  balance,
                };
              } catch (error) {
                logger.warn(
                  `Failed to fetch balance for wallet ${wallet.publicKey}:`,
                  error
                );
                return {
                  ...wallet,
                  balance: { lumens: '0', error: 'Failed to fetch balance' },
                };
              }
            })
          );
        }

        reply.send(
          formatSuccess({
            wallets: walletsWithBalance,
            count: walletsWithBalance.length,
          })
        );
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * DELETE /api/v1/wallet/:walletId
   * Unlink a wallet from user account
   * User can remove wallets they no longer want to use
   *
   * Requires: authenticated user
   * Params: walletId (wallet to unlink)
   * Returns: { message: string }
   */
  app.delete<{ Params: { walletId: string } }>(
    '/api/v1/wallet/:walletId',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        const { walletId } = request.params;

        logger.debug(
          `Unlinking wallet: ${walletId} for user: ${user.userId}`
        );

        await unlinkWallet(prisma, user.userId, walletId);

        reply.send(
          formatSuccess({
            message: 'Wallet successfully unlinked',
            walletId,
          })
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          reply.code(404).send(formatError(error.message, 'WALLET_NOT_FOUND'));
        } else if (error instanceof Error && error.message.includes('does not belong')) {
          reply.code(403).send(formatError(error.message, 'FORBIDDEN'));
        } else if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'WALLET_UNLINK_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * PATCH /api/v1/wallet/:walletId/name
   * Update wallet display name
   * Users can rename their wallets (e.g., "Main Wallet", "Trading Account")
   *
   * Requires: authenticated user
   * Params: walletId (wallet to rename)
   * Body: { name: string }
   * Returns: { id: string, publicKey: string, name: string }
   */
  app.patch<{ Params: { walletId: string }; Body: any }>(
    '/api/v1/wallet/:walletId/name',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        const { walletId } = request.params;
        const body = UpdateWalletNameSchema.parse(request.body);

        logger.debug(
          `Updating wallet name: ${walletId} to "${body.name}"`
        );

        const result = await updateWalletName(
          prisma,
          user.userId,
          walletId,
          body.name
        );

        reply.send(
          formatSuccess({
            ...result,
            message: 'Wallet name updated successfully',
          })
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message, 'VALIDATION_ERROR'));
        } else if (error instanceof Error && error.message.includes('not found')) {
          reply.code(404).send(formatError(error.message, 'WALLET_NOT_FOUND'));
        } else if (error instanceof Error && error.message.includes('does not belong')) {
          reply.code(403).send(formatError(error.message, 'FORBIDDEN'));
        } else if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'WALLET_UPDATE_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * GET /api/v1/wallet/:walletId/balance
   * Get current balance for a specific wallet
   * Returns both native lumens (XLM) and USDC balance if available
   *
   * Requires: authenticated user (must own the wallet)
   * Params: walletId (wallet to check balance)
   * Returns: { lumens: string, usdc?: string }
   */
  app.get<{ Params: { walletId: string } }>(
    '/api/v1/wallet/:walletId/balance',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('User not found');
        }

        const { walletId } = request.params;

        // Verify wallet belongs to user
        const wallet = await prisma.wallet.findUnique({
          where: { id: walletId },
        });

        if (!wallet) {
          reply.code(404).send(formatError('Wallet not found', 'WALLET_NOT_FOUND'));
          return;
        }

        if (wallet.userId !== user.userId) {
          reply.code(403).send(formatError('Access denied', 'FORBIDDEN'));
          return;
        }

        logger.debug(`Fetching balance for wallet: ${walletId}`);

        const balance = await getWalletBalance(wallet.publicKey);

        reply.send(
          formatSuccess({
            walletId,
            publicKey: wallet.publicKey,
            ...balance,
          })
        );
      } catch (error) {
        if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'BALANCE_FETCH_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );
};
