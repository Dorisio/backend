import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../middleware/auth';
import { getQueueHealth } from '../../lib/queue';
import { getJobStatus, QUEUE_NAMES } from '../../lib/jobs/status';
import {
  enqueueAnalytics,
  enqueueEmail,
  enqueueExport,
  enqueueImageProcessing,
} from '../../lib/jobs/enqueue';
import { formatSuccess, formatError } from '../../types/response';
import { AppError, ValidationError } from '../../utils/errors';

export function registerJobRoutes(app: FastifyInstance): void {
  app.get(
    '/api/v1/jobs/health',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.user?.role !== 'admin') {
        reply.code(403).send(formatError('Admin only', 'FORBIDDEN'));
        return;
      }
      const health = await getQueueHealth();
      reply.send(formatSuccess({ queues: health }));
    },
  );

  app.get(
    '/api/v1/jobs/:queue/:id',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { queue, id } = request.params as { queue: string; id: string };
      const status = await getJobStatus(queue, id);
      if (!status) {
        reply.code(404).send(formatError('Job not found', 'NOT_FOUND'));
        return;
      }
      reply.send(formatSuccess(status));
    },
  );

  app.post(
    '/api/v1/jobs/email',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as { to?: string; subject?: string; body?: string };
        if (!body?.to || !body.subject || !body.body) {
          throw new ValidationError('to, subject, and body are required');
        }
        const job = await enqueueEmail({ to: body.to, subject: body.subject, body: body.body });
        reply.code(202).send(formatSuccess({ id: job.id, queue: QUEUE_NAMES.email }));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
          return;
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/jobs/analytics',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { creatorId?: string; rangeDays?: number };
      if (!body?.creatorId) {
        reply.code(400).send(formatError('creatorId required', 'VALIDATION_ERROR'));
        return;
      }
      const job = await enqueueAnalytics({ creatorId: body.creatorId, rangeDays: body.rangeDays });
      reply.code(202).send(formatSuccess({ id: job.id, queue: QUEUE_NAMES.analytics }));
    },
  );

  app.post(
    '/api/v1/jobs/export',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { type?: 'tips' | 'payouts' | 'analytics'; format?: 'csv' | 'json' };
      if (!request.user) {
        reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
        return;
      }
      if (!body?.type) {
        reply.code(400).send(formatError('type required', 'VALIDATION_ERROR'));
        return;
      }
      const job = await enqueueExport({
        userId: request.user.userId,
        type: body.type,
        format: body.format,
      });
      reply.code(202).send(formatSuccess({ id: job.id, queue: QUEUE_NAMES.exports }));
    },
  );

  app.post(
    '/api/v1/jobs/images',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { assetUrl?: string; operations?: string[] };
      if (!body?.assetUrl || !body.operations?.length) {
        reply.code(400).send(formatError('assetUrl and operations required', 'VALIDATION_ERROR'));
        return;
      }
      const job = await enqueueImageProcessing({
        assetUrl: body.assetUrl,
        operations: body.operations,
        userId: request.user?.userId,
      });
      reply.code(202).send(formatSuccess({ id: job.id, queue: QUEUE_NAMES.imageProcessing }));
    },
  );
}
