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
} from '../../lib/stellar/wallet';
import { ValidationError, AppError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const GenerateNonceSchema = z.object({
  publicKey: z.string().min(1, 'Public key is required'),
});

const VerifyWalletSchema = z.object({
  publicKey: z.string().min(1, 'Public key is required'),
  nonce: z.string().min(1, 'Nonce is required'),
  signedTransaction: z.string().min(1, 'Signed transaction is required'),
});

const UnlinkWalletSchema = z.object({
  walletId: z.string().min(1, 'Wallet ID is required'),
});

export const registerWalletRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  // POST /api/v1/wallet/nonce - Generate challenge nonce
  app.post<{ Body: any }>(
    '/api/v1/wallet/nonce',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = GenerateNonceSchema.parse(request.body);
        const nonce = await generateWalletNonce(body.publicKey);

        reply.code(201).send(
          formatSuccess({
            nonce,
            expiresIn: 600, // 10 minutes
          })
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'INVALID_PUBLIC_KEY'));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/wallet/challenge/:nonce - Get challenge transaction
  app.get<{ Params: { nonce: string } }>(
    '/api/v1/wallet/challenge/:nonce',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { nonce } = request.params;
        const challengeTransaction = await getWalletChallenge(nonce);

        reply.send(
          formatSuccess({
            challenge: challengeTransaction,
          })
        );
      } catch (error) {
        if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'CHALLENGE_ERROR'));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/wallet/verify - Verify signed challenge and link wallet
  app.post<{ Body: any }>(
    '/api/v1/wallet/verify',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new Error('User not found in request');
        }

        const body = VerifyWalletSchema.parse(request.body);

        const result = await verifyAndLinkWallet(
          prisma,
          user.userId,
          body.publicKey,
          body.nonce,
          body.signedTransaction
        );

        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'WALLET_VERIFICATION_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/wallet/list - Get user's wallets
  app.get<{ Querystring: { includeBalance?: string } }>(
    '/api/v1/wallet/list',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new Error('User not found in request');
        }

        const wallets = await getUserWallets(prisma, user.userId);
        const includeBalance = request.query.includeBalance === 'true';

        let walletsWithBalance = wallets;

        if (includeBalance) {
          walletsWithBalance = await Promise.all(
            wallets.map(async (wallet) => {
              try {
                const balance = await getWalletBalance(wallet.publicKey);
                return {
                  ...wallet,
                  balance,
                };
              } catch (error) {
                logger.warn(`Failed to fetch balance for wallet ${wallet.publicKey}:`, error);
                return {
                  ...wallet,
                  balance: { lumens: '0' },
                };
              }
            })
          );
        }

        reply.send(formatSuccess({ wallets: walletsWithBalance }));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // DELETE /api/v1/wallet/:walletId - Unlink wallet
  app.delete<{ Params: { walletId: string } }>(
    '/api/v1/wallet/:walletId',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) {
          throw new Error('User not found in request');
        }

        const { walletId } = request.params;
        await unlinkWallet(prisma, user.userId, walletId);

        reply.send(formatSuccess({ message: 'Wallet unlinked successfully' }));
      } catch (error) {
        if (error instanceof Error) {
          reply.code(400).send(formatError(error.message, 'WALLET_UNLINK_FAILED'));
        } else {
          throw error;
        }
      }
    }
  );
};
