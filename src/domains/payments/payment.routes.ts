import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from './payment.service';
import { UnauthorizedError } from '../../utils/errors';
import {
  BuildPaymentTransactionInput,
  BuildPaymentTransactionSchema,
  CreateTipInput,
  CreateTipSchema,
  CreatorIdParamsSchema,
  SubmitPaymentTransactionInput,
  SubmitPaymentTransactionSchema,
  TipHistoryQueryInput,
  TipHistoryQuerySchema,
  TipIdParamsSchema,
  UpdateTipStatusSchema,
  buildPaymentTransactionJsonSchema,
  createTipJsonSchema,
  creatorIdParamsJsonSchema,
  submitPaymentTransactionJsonSchema,
  tipHistoryQueryJsonSchema,
  tipIdParamsJsonSchema,
  updateTipStatusJsonSchema,
} from './payment.schemas';
import { formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { rateLimitTipCreation } from '../../middleware/rate-limit';
import { validateRequest } from '../../middleware/validation';

export const registerPaymentRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const paymentService = new PaymentService(prisma);

  /**
   * POST /api/v1/transactions/tip
   * Create a new tip (initial step before payment transaction)
   * Requires: authenticated user with verified wallet
   * Rate limited: 10 tips per hour
   */
  app.post<{ Body: CreateTipInput }>(
    '/api/v1/transactions/tip',
    {
      preHandler: [authMiddleware, rateLimitTipCreation, validateRequest({ body: CreateTipSchema })],
      schema: {
        body: createTipJsonSchema,
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
    async (request: FastifyRequest<{ Body: CreateTipInput }>, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        throw new UnauthorizedError('Authentication required');
      }

      const result = await paymentService.createTip(user.userId, request.body);
      reply.code(201).send(formatSuccess(result));
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
      preHandler: [validateRequest({ params: TipIdParamsSchema })],
      schema: {
        params: tipIdParamsJsonSchema,
        response: {
          200: { description: 'Tip details' },
          404: { description: 'Tip not found' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = await paymentService.getTip(request.params.id);
      reply.send(formatSuccess(result));
    }
  );

  /**
   * GET /api/v1/transactions/history
   * Get user's tip history (tips they sent)
   * Requires: authenticated user
   * Supports offset and cursor pagination (default pageSize: 20, max: 100), multi-column sorting, and status filtering
   */
  app.get<{ Querystring: TipHistoryQueryInput }>(
    '/api/v1/transactions/history',
    {
      preHandler: [authMiddleware, validateRequest({ query: TipHistoryQuerySchema })],
      schema: {
        querystring: tipHistoryQueryJsonSchema,
        response: {
          200: { description: 'User tip history with pagination metadata' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: TipHistoryQueryInput }>, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        throw new UnauthorizedError('Authentication required');
      }

      const query = request.query;
      const isCursor = Boolean(query.cursor || query.after || query.first);

      if (isCursor) {
        const limit = query.first ?? query.limit ?? query.pageSize ?? 20;
        const result = await paymentService.getUserTipHistoryCursor(user.userId, {
          limit,
          cursor: query.cursor,
          after: query.after,
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          status: query.status,
        });
        reply.send(formatSuccess(result));
      } else {
        const page = query.page ?? 1;
        const pageSize = query.pageSize ?? query.limit ?? 20;

        const result = await paymentService.getUserTipHistory(user.userId, page, pageSize, {
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          status: query.status,
        });
        reply.send(formatSuccess(result));
      }
    }
  );

  /**
   * GET /api/v1/transactions/creator/:creatorId
   * Get tips received by a creator
   * Public endpoint (no auth required)
   * Supports offset and cursor pagination (default pageSize: 20, max: 100), multi-column sorting, and status filtering
   */
  app.get<{ Params: { creatorId: string }; Querystring: TipHistoryQueryInput }>(
    '/api/v1/transactions/creator/:creatorId',
    {
      preHandler: [
        validateRequest({ params: CreatorIdParamsSchema, query: TipHistoryQuerySchema }),
      ],
      schema: {
        params: creatorIdParamsJsonSchema,
        querystring: tipHistoryQueryJsonSchema,
        response: {
          200: { description: 'Tips received by creator with pagination metadata' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { creatorId: string }; Querystring: TipHistoryQueryInput }>,
      reply: FastifyReply
    ) => {
      const { creatorId } = request.params;
      const query = request.query;
      const isCursor = Boolean(query.cursor || query.after || query.first);

      if (isCursor) {
        const limit = query.first ?? query.limit ?? query.pageSize ?? 20;
        const result = await paymentService.listTipsCursor(creatorId, {
          limit,
          cursor: query.cursor,
          after: query.after,
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          status: query.status,
        });
        reply.send(formatSuccess(result));
      } else {
        const page = query.page ?? 1;
        const pageSize = query.pageSize ?? query.limit ?? 20;

        const result = await paymentService.listTips(creatorId, page, pageSize, {
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          status: query.status,
        });
        reply.send(formatSuccess(result));
      }
    }
  );

  /**
   * PATCH /api/v1/transactions/:id/status
   * Update tip status (typically used by transaction confirmation service)
   * Requires: authenticated user (future: admin or service account)
   */
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/transactions/:id/status',
    {
      preHandler: [authMiddleware, validateRequest({ params: TipIdParamsSchema, body: UpdateTipStatusSchema })],
      schema: {
        params: tipIdParamsJsonSchema,
        body: updateTipStatusJsonSchema,
        response: {
          200: { description: 'Tip status updated' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
      const result = await paymentService.updateTipStatus(
        request.params.id,
        request.body as Parameters<PaymentService['updateTipStatus']>[1]
      );
      reply.send(formatSuccess(result));
    }
  );

  /**
   * POST /api/v1/transactions/:id/build
   * Build a Stellar payment transaction for frontend signing
   * Requires: authenticated user
   * Body: { senderPublicKey, creatorPublicKey, amount, assetCode?, assetIssuer? }
   */
  app.post<{ Params: { id: string }; Body: BuildPaymentTransactionInput }>(
    '/api/v1/transactions/:id/build',
    {
      preHandler: [authMiddleware, validateRequest({ params: TipIdParamsSchema, body: BuildPaymentTransactionSchema })],
      schema: {
        params: tipIdParamsJsonSchema,
        body: buildPaymentTransactionJsonSchema,
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: BuildPaymentTransactionInput }>,
      reply: FastifyReply
    ) => {
      const user = request.user;
      if (!user) {
        throw new UnauthorizedError('Authentication required');
      }

      const { senderPublicKey, creatorPublicKey, amount, assetCode, assetIssuer } = request.body;

      const result = await paymentService.buildPaymentTransaction(
        request.params.id,
        senderPublicKey,
        creatorPublicKey,
        amount,
        assetCode,
        assetIssuer || process.env.USDC_ISSUER
      );

      reply.code(200).send(formatSuccess(result));
    }
  );

  /**
   * POST /api/v1/transactions/:id/submit
   * Submit a signed Stellar payment transaction
   * Requires: authenticated user
   * Body: { transactionEnvelope: string }
   */
  app.post<{ Params: { id: string }; Body: SubmitPaymentTransactionInput }>(
    '/api/v1/transactions/:id/submit',
    {
      preHandler: [authMiddleware, validateRequest({ params: TipIdParamsSchema, body: SubmitPaymentTransactionSchema })],
      schema: {
        params: tipIdParamsJsonSchema,
        body: submitPaymentTransactionJsonSchema,
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: SubmitPaymentTransactionInput }>,
      reply: FastifyReply
    ) => {
      const user = request.user;
      if (!user) {
        throw new UnauthorizedError('Authentication required');
      }

      const result = await paymentService.submitPaymentTransaction(
        request.params.id,
        request.body.transactionEnvelope
      );
      reply.code(200).send(formatSuccess(result));
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
    {
      preHandler: [authMiddleware, validateRequest({ params: TipIdParamsSchema })],
      schema: {
        params: tipIdParamsJsonSchema,
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = await paymentService.checkTransactionConfirmation(request.params.id);
      reply.send(formatSuccess(result));
    }
  );
};
