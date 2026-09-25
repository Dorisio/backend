import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from './payment.service';
import {
  CreateTipSchema,
  UpdateTipStatusSchema,
  BuildPaymentTransactionSchema,
  SubmitPaymentTransactionSchema,
  UpdateTipStatusRequest,
  BuildPaymentTransactionRequest,
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
    {
      preHandler: [authMiddleware, rateLimitTipCreation],
      schema: {
        body: {
          type: 'object',
          required: ['creatorId', 'amount'],
          properties: {
            creatorId: { type: 'string' },
            amount: { type: 'number', minimum: 1 },
            message: { type: 'string' },
            currency: { type: 'string', default: 'USD' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  creatorId: { type: 'string' },
                  amount: { type: 'number' },
                  status: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
          400: { description: 'Validation error' },
          401: { description: 'Unauthorized' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
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
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tip ID' },
          },
        },
        response: {
          200: { description: 'Tip details' },
          404: { description: 'Tip not found' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
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
   * Supports offset and cursor pagination (default pageSize: 20, max: 100), multi-column sorting, and status filtering
   */
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      limit?: string;
      cursor?: string;
      after?: string;
      first?: string;
      sortBy?: string;
      sortOrder?: string;
      status?: string;
    };
  }>(
    '/api/v1/transactions/history',
    {
      preHandler: authMiddleware,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string', default: '1', description: 'Page number (offset pagination)' },
            pageSize: { type: 'string', default: '20', description: 'Items per page (max 100)' },
            limit: { type: 'string', description: 'Alias for pageSize / cursor limit (max 100)' },
            cursor: { type: 'string', description: 'Opaque cursor for keyset pagination' },
            after: { type: 'string', description: 'Opaque cursor after which to fetch results' },
            first: { type: 'string', description: 'Number of items to fetch with cursor' },
            sortBy: { type: 'string', description: 'Sort field(s) comma separated, e.g. createdAt,amount' },
            sortOrder: { type: 'string', enum: ['asc', 'desc', 'ASC', 'DESC'], description: 'Sort order' },
            status: { type: 'string', description: 'Filter by tip status' },
          },
        },
        response: {
          200: { description: 'User tip history with pagination metadata' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const query = request.query as Record<string, any>;
        const isCursor = Boolean(query.cursor || query.after || query.first);

        if (isCursor) {
          const limit = query.first ? parseInt(query.first) : query.limit ? parseInt(query.limit) : query.pageSize ? parseInt(query.pageSize) : 20;
          const result = await paymentService.getUserTipHistoryCursor(user.userId, {
            limit,
            cursor: query.cursor,
            after: query.after,
            sortBy: query.sortBy,
            sortOrder: query.sortOrder?.toLowerCase() as 'asc' | 'desc',
            status: query.status,
          });
          reply.send(formatSuccess(result));
        } else {
          const page = query.page ? parseInt(query.page) : 1;
          const pageSize = query.pageSize ? parseInt(query.pageSize) : query.limit ? parseInt(query.limit) : 20;

          const result = await paymentService.getUserTipHistory(user.userId, page, pageSize, {
            sortBy: query.sortBy,
            sortOrder: query.sortOrder?.toLowerCase() as 'asc' | 'desc',
            status: query.status,
          });
          reply.send(formatSuccess(result));
        }
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
   * Supports offset and cursor pagination (default pageSize: 20, max: 100), multi-column sorting, and status filtering
   */
  app.get<{
    Params: { creatorId: string };
    Querystring: {
      page?: string;
      pageSize?: string;
      limit?: string;
      cursor?: string;
      after?: string;
      first?: string;
      sortBy?: string;
      sortOrder?: string;
      status?: string;
    };
  }>(
    '/api/v1/transactions/creator/:creatorId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            creatorId: { type: 'string', description: 'Creator ID' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string', default: '1', description: 'Page number (offset pagination)' },
            pageSize: { type: 'string', default: '20', description: 'Items per page (max 100)' },
            limit: { type: 'string', description: 'Alias for pageSize / cursor limit (max 100)' },
            cursor: { type: 'string', description: 'Opaque cursor for keyset pagination' },
            after: { type: 'string', description: 'Opaque cursor after which to fetch results' },
            first: { type: 'string', description: 'Number of items to fetch with cursor' },
            sortBy: { type: 'string', description: 'Sort field(s) comma separated, e.g. createdAt,amount' },
            sortOrder: { type: 'string', enum: ['asc', 'desc', 'ASC', 'DESC'], description: 'Sort order' },
            status: { type: 'string', description: 'Filter by tip status' },
          },
        },
        response: {
          200: { description: 'Tips received by creator with pagination metadata' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { creatorId } = request.params as { creatorId: string };
        const query = request.query as Record<string, any>;
        const isCursor = Boolean(query.cursor || query.after || query.first);

        if (isCursor) {
          const limit = query.first ? parseInt(query.first) : query.limit ? parseInt(query.limit) : query.pageSize ? parseInt(query.pageSize) : 20;
          const result = await paymentService.listTipsCursor(creatorId, {
            limit,
            cursor: query.cursor,
            after: query.after,
            sortBy: query.sortBy,
            sortOrder: query.sortOrder?.toLowerCase() as 'asc' | 'desc',
            status: query.status,
          });
          reply.send(formatSuccess(result));
        } else {
          const page = query.page ? parseInt(query.page) : 1;
          const pageSize = query.pageSize ? parseInt(query.pageSize) : query.limit ? parseInt(query.limit) : 20;

          const result = await paymentService.listTips(creatorId, page, pageSize, {
            sortBy: query.sortBy,
            sortOrder: query.sortOrder?.toLowerCase() as 'asc' | 'desc',
            status: query.status,
          });
          reply.send(formatSuccess(result));
        }
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
  app.patch<{ Params: { id: string }; Body: UpdateTipStatusRequest }>(
    '/api/v1/transactions/:id/status',
    {
      preHandler: authMiddleware,
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Tip ID' },
          },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['pending', 'confirmed', 'failed'] },
            transactionHash: { type: 'string', description: 'Stellar transaction hash' },
          },
        },
        response: {
          200: { description: 'Tip status updated' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
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
  app.post<{ Params: { id: string }; Body: BuildPaymentTransactionRequest }>(
    '/api/v1/transactions/:id/build',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
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
        const { id } = request.params as { id: string };
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
        const { id } = request.params as { id: string };
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
