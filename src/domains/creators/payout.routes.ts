import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { PayoutService } from './payout.service';
import { CreatorPayoutSchema } from './creator.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError } from '../../utils/errors';

export const registerCreatorPayoutRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const payoutService = new PayoutService(prisma);

  // GET /api/v1/creators/dashboard - Get creator dashboard
  app.get(
    '/api/v1/creators/dashboard',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        // Get creator profile for this user
        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const result = await payoutService.getCreatorDashboard(creator.id);
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

  // GET /api/v1/creators/earnings - Get earnings breakdown
  app.get(
    '/api/v1/creators/earnings',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const result = await payoutService.getEarningsBreakdown(creator.id);
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

  // POST /api/v1/creators/payout - Request payout
  app.post<{ Body: any }>(
    '/api/v1/creators/payout',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const body = CreatorPayoutSchema.parse(request.body);

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const result = await payoutService.processPayout(creator.id, body);
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

  // GET /api/v1/creators/completeness - Get profile completeness checklist
  app.get(
    '/api/v1/creators/completeness',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator profile not found', 'NOT_FOUND'));
          return;
        }

        const result = await payoutService.getCreatorCompletenessChecklist(creator.id);
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
};
