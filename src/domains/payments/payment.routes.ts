import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from './payment.service';
import { CreateTipSchema, UpdateTipStatusSchema } from './payment.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError } from '../../utils/errors';

export const registerPaymentRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const paymentService = new PaymentService(prisma);

  // POST /api/v1/transactions/tip - Create a new tip
  app.post<{ Body: any }>(
    '/api/v1/transactions/tip',
    { preHandler: authMiddleware },
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
          reply
            .code(400)
            .send(
              formatError((error as any).message || 'Invalid request body', 'VALIDATION_ERROR')
            );
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/transactions/:id - Get a specific tip
  app.get<{ Params: { id: string } }>(
    '/api/v1/transactions/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const result = await paymentService.getTip(id);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/transactions/history - Get user's tip history
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
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/transactions/creator/:creatorId - Get tips for a creator
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
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // PATCH /api/v1/transactions/:id/status - Update tip status
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
          reply
            .code(400)
            .send(
              formatError((error as any).message || 'Invalid request body', 'VALIDATION_ERROR')
            );
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/transactions/:id/build - Build Stellar payment transaction
  app.post<{ Params: { id: string }; Body: any }>(
    '/api/v1/transactions/:id/build',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const body = CreateTipSchema.parse(request.body);
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const buildSchema = CreateTipSchema.extend({
          senderPublicKey: CreateTipSchema.shape.creatorId,
          creatorPublicKey: CreateTipSchema.shape.creatorId,
        });

        const { senderPublicKey, creatorPublicKey, amount } = request.body;

        const transactionEnvelope = await paymentService.buildPaymentTransaction(
          id,
          senderPublicKey,
          creatorPublicKey,
          amount.toString(),
          'USDC',
          process.env.USDC_ISSUER
        );

        reply.send(
          formatSuccess({
            transactionEnvelope,
            tipId: id,
          })
        );
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

  // POST /api/v1/transactions/:id/submit - Submit signed Stellar transaction
  app.post<{ Params: { id: string }; Body: any }>(
    '/api/v1/transactions/:id/submit',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const { transactionEnvelope } = request.body;

        if (!transactionEnvelope) {
          throw new ValidationError('Signed transaction envelope is required');
        }

        const result = await paymentService.submitPaymentTransaction(id, transactionEnvelope);
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

  // GET /api/v1/transactions/:id/confirm - Check transaction confirmation
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
