import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { WebhookService, CreateWebhookRequest } from './webhook.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError } from '../../utils/errors';

export const registerWebhookRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const webhookService = new WebhookService(prisma);

  // POST /api/v1/webhooks - Register a webhook
  app.post<{ Body: CreateWebhookRequest }>(
    '/api/v1/webhooks',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Register a webhook to receive events when tips are created and confirmed.',
        body: {
          type: 'object',
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', format: 'uri', description: 'Webhook URL' },
            events: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Events to subscribe to (tip.created, tip.confirmed, tip.failed, payout.completed)',
            },
          },
        },
        response: {
          201: { description: 'Webhook registered' },
          400: { description: 'Validation error' },
          401: { description: 'Unauthorized' },
        },
      } as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        // Get creator for this user
        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
          select: { id: true },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const body = request.body as CreateWebhookRequest;
        const result = await webhookService.registerWebhook(creator.id, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(400).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/webhooks - List webhooks (paginated, default 20 / max 100)
  app.get<{
    Querystring: { page?: string; pageSize?: string; limit?: string };
  }>(
    '/api/v1/webhooks',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Get webhooks registered for the creator (paginated, max 100 per page).',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string', default: '1', description: 'Page number' },
            pageSize: { type: 'string', default: '20', description: 'Items per page (max 100)' },
            limit: { type: 'string', description: 'Alias for pageSize (max 100)' },
          },
        },
        response: {
          200: { description: 'List of webhooks' },
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
          select: { id: true },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const query = (request.query ?? {}) as { page?: string; pageSize?: string; limit?: string };
        const result = await webhookService.listWebhooks(
          creator.id,
          query.page ? parseInt(query.page, 10) : 1,
          query.pageSize
            ? parseInt(query.pageSize, 10)
            : query.limit
              ? parseInt(query.limit, 10)
              : 20
        );
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

  // DELETE /api/v1/webhooks/:id - Delete webhook
  app.delete<{ Params: { id: string } }>(
    '/api/v1/webhooks/:id',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Delete a registered webhook.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Webhook ID' },
          },
        },
        response: {
          200: { description: 'Webhook deleted' },
          401: { description: 'Unauthorized' },
          404: { description: 'Webhook not found' },
        },
      } as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
          select: { id: true },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const { id } = request.params as { id: string };
        await webhookService.deleteWebhook(id, creator.id);
        reply.send(formatSuccess({ message: 'Webhook deleted' }));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(400).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/webhooks/:id/history - Get delivery history
  app.get<{
    Params: { id: string };
    Querystring: { page?: string; pageSize?: string; limit?: string; status?: string };
  }>(
    '/api/v1/webhooks/:id/history',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Get recent webhook delivery attempts and their status.',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Webhook ID' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string', default: '1', description: 'Page number' },
            pageSize: { type: 'string', default: '20', description: 'Items per page (max 100)' },
            limit: { type: 'string', description: 'Alias for pageSize (max 100)' },
            status: { type: 'string', description: 'Filter by delivery status' },
          },
        },
        response: {
          200: { description: 'Delivery history with pagination' },
          401: { description: 'Unauthorized' },
          404: { description: 'Webhook not found' },
        },
      } as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const creator = await prisma.creator.findUnique({
          where: { userId: user.userId },
          select: { id: true },
        });

        if (!creator) {
          reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
          return;
        }

        const { id } = request.params as { id: string };
        const query = request.query as { page?: string; pageSize?: string; limit?: string; status?: string };
        const page = query.page ? parseInt(query.page) : 1;
        const pageSize = query.pageSize ? parseInt(query.pageSize) : query.limit ? parseInt(query.limit) : 20;

        const result = await webhookService.getDeliveryHistory(id, creator.id, page, pageSize, query.status);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(400).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );
};
