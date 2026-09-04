import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from './payment.service';
import {
  CreateTipSchema,
  UpdateTipStatusSchema,
  BuildPaymentTransactionSchema,
  SubmitPaymentTransactionSchema,
} from './payment.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { rateLimitTipCreation } from '../../middleware/rate-limit';
import { ValidationError, AppError, NotFoundError } from '../../utils/errors';

export const registerPaymentRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const paymentService = new PaymentService(prisma);

  /**
   * POST /api/v1/transactions/tip
   * Create a new tip (initial step before payment transaction)
   * Requires: authenticated user with verified wallet
   * Rate limited: 10 tips per hour
   */
  app.post<{ Body: any }>(
    '/api/v1/transactions/tip',
    { preHandler: [authMiddleware, rateLimitTipCreation] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = CreateTipSchema.parse(request.body);
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const result = await paymentService.createTip(user.userId, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message || 'Invalid request', 'VALIDATION_ERROR'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * GET /api/v1/transactions/:id
   * Get a specific tip by ID
   * Public endpoint (no auth required)
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/transactions/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const result = await paymentService.getTip(id);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof NotFoundError) {
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
   * GET /api/v1/transactions/history
   * Get user's tip history (tips they sent)
   * Requires: authenticated user
   * Supports pagination: page (default 1), pageSize (default 10, max 100)
   */
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    '/api/v1/transactions/history',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const page = request.query.page ? parseInt(request.query.page) : 1;
        const pageSize = request.query.pageSize ? parseInt(request.query.pageSize) : 10;

        const result = await paymentService.getUserTipHistory(user.userId, page, pageSize);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
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
   * GET /api/v1/transactions/creator/:creatorId
   * Get tips received by a creator
   * Public endpoint (no auth required)
   * Supports pagination: page (default 1), pageSize (default 10, max 100)
   */
  app.get<{ Params: { creatorId: string }; Querystring: { page?: string; pageSize?: string } }>(
    '/api/v1/transactions/creator/:creatorId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { creatorId } = request.params;
        const page = request.query.page ? parseInt(request.query.page) : 1;
        const pageSize = request.query.pageSize ? parseInt(request.query.pageSize) : 10;

        const result = await paymentService.listTips(creatorId, page, pageSize);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
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
   * PATCH /api/v1/transactions/:id/status
   * Update tip status (typically used by transaction confirmation service)
   * Requires: authenticated user (future: admin or service account)
   */
  app.patch<{ Params: { id: string }; Body: any }>(
    '/api/v1/transactions/:id/status',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const body = UpdateTipStatusSchema.parse(request.body);

        const result = await paymentService.updateTipStatus(id, body);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message || 'Invalid request', 'VALIDATION_ERROR'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * POST /api/v1/transactions/:id/build
   * Build a Stellar payment transaction for frontend signing
   * Requires: authenticated user
   * Body: { senderPublicKey, creatorPublicKey, amount, assetCode?, assetIssuer? }
   */
  app.post<{ Params: { id: string }; Body: any }>(
    '/api/v1/transactions/:id/build',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const body = BuildPaymentTransactionSchema.parse(request.body);
        const { senderPublicKey, creatorPublicKey, amount, assetCode, assetIssuer } = body;

        const result = await paymentService.buildPaymentTransaction(
          id,
          senderPublicKey,
          creatorPublicKey,
          amount,
          assetCode,
          assetIssuer || process.env.USDC_ISSUER
        );

        reply.code(200).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message || 'Invalid request', 'VALIDATION_ERROR'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * POST /api/v1/transactions/:id/submit
   * Submit a signed Stellar payment transaction
   * Requires: authenticated user
   * Body: { transactionEnvelope: string }
   */
  app.post<{ Params: { id: string }; Body: any }>(
    '/api/v1/transactions/:id/submit',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const body = SubmitPaymentTransactionSchema.parse(request.body);
        const { transactionEnvelope } = body;

        const result = await paymentService.submitPaymentTransaction(id, transactionEnvelope);
        reply.code(200).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply.code(400).send(formatError(error.message || 'Invalid request', 'VALIDATION_ERROR'));
        } else {
          throw error;
        }
      }
    }
  );

  /**
   * GET /api/v1/transactions/:id/confirm
   * Check transaction confirmation status
   * Requires: authenticated user
   * Polls Horizon to check if transaction has been confirmed
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/transactions/:id/confirm',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const result = await paymentService.checkTransactionConfirmation(id);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );
};
