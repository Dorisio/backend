import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError, NotFoundError } from '../../utils/errors';

export const registerAnalyticsRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const analyticsService = new AnalyticsService(prisma);

  // GET /api/v1/analytics/summary - Summary stats
  app.get(
    '/api/v1/analytics/summary',
    {
      preHandler: authMiddleware,
      schema: {

        response: {
          200: { description: 'Summary statistics' },
          401: { description: 'Unauthorized' },
        },
      } as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const result = await analyticsService.getSummaryStats(creator.id);
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

  // GET /api/v1/analytics/earnings - Earnings over time
  app.get<{ Querystring: { days?: string; granularity?: string } }>(
    '/api/v1/analytics/earnings',
    {
      preHandler: authMiddleware,
      schema {



        querystring: {
          type: 'object',
          properties: {
            days: {
              type: 'string',
              default: '30',

            },
            granularity: {
              type: 'string',
              enum: ['daily', 'weekly', 'monthly'],
              default: 'daily',
            },
          },
        },
        response: {
          200: { description: 'Earnings data' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const query = request.query as { days?: string; granularity?: string };
        const days = query.days ? parseInt(query.days) : 30;
        const granularity = (query.granularity as 'daily' | 'weekly' | 'monthly') || 'daily';

        if (days < 1 || days > 365) {
          reply.code(400).send(formatError('Days must be between 1 and 365', 'INVALID_RANGE'));
          return;
        }

        const result = await analyticsService.getEarningsOverTime(creator.id, days, granularity);
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

  // GET /api/v1/analytics/supporters - Top supporters
  app.get<{ Querystring: { limit?: string } }>(
    '/api/v1/analytics/supporters',
    {
      preHandler: authMiddleware,
      schema: {
        
        

        
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'string',
              default: '10',

            },
          },
        },
        response: {
          200: { description: 'Top supporters list' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const query = request.query as { limit?: string };
        const limit = query.limit ? Math.min(parseInt(query.limit), 100) : 10;

        const result = await analyticsService.getTopSupporters(creator.id, limit);
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

  // GET /api/v1/analytics/frequency - Tip frequency
  app.get<{ Querystring: { days?: string } }>(
    '/api/v1/analytics/frequency',
    {
      preHandler: authMiddleware,
      schema: {
        
        

        
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'string', default: '30', description: 'Number of days to analyze' },
          },
        },
        response: {
          200: { description: 'Frequency statistics' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const query = request.query as { days?: string };
        const days = query.days ? parseInt(query.days) : 30;

        if (days < 1 || days > 365) {
          reply.code(400).send(formatError('Days must be between 1 and 365', 'INVALID_RANGE'));
          return;
        }

        const result = await analyticsService.getTipFrequency(creator.id, days);
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
