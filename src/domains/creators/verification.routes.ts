import { createReadStream } from 'node:fs';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAdmin, requireCreator } from '../../middleware/rbac';
import { formatSuccess } from '../../types/response';
import { ValidationError } from '../../utils/errors';
import { VerificationService } from './verification.service';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SubmitRequestSchema = z.object({
  statement: z.string().trim().max(2000).optional(),
  documents: z.array(z.object({
    filename: z.string().min(1).max(255),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    data: z.string().regex(BASE64_PATTERN, 'Document data must be base64 encoded'),
  })).min(1).max(5),
});
const ReviewSchema = z.object({ reason: z.string().trim().max(2000).optional() });
const RejectionSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

function pageValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const registerVerificationRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const service = new VerificationService(prisma);

  app.post<{ Body: z.infer<typeof SubmitRequestSchema> }>(
    '/api/v1/creators/verification-requests',
    { preHandler: requireCreator, bodyLimit: 70 * 1024 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) throw new ValidationError('User is not authenticated');
      const body = SubmitRequestSchema.parse(request.body);
      const documents = body.documents.map(({ data, ...document }) => {
        const decoded = Buffer.from(data, 'base64');
        if (decoded.toString('base64') !== data) {
          throw new ValidationError('Document data must be valid base64');
        }
        return { ...document, data: decoded };
      });
      const result = await service.submitRequest(user.userId, { statement: body.statement, documents });
      reply.code(201).send(formatSuccess(result));
    },
  );

  app.get(
    '/api/v1/creators/verification-requests',
    { preHandler: requireCreator },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) throw new ValidationError('User is not authenticated');
      reply.send(formatSuccess(await service.getRequestHistory(user.userId)));
    },
  );

  app.get<{ Querystring: { page?: string; pageSize?: string; limit?: string } }>(
    '/api/v1/admin/creator-verification/requests',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { page?: string; pageSize?: string; limit?: string };
      const result = await service.getPendingRequests(
        pageValue(query.page, 1),
        pageValue(query.pageSize ?? query.limit, 20),
      );
      reply.send(formatSuccess(result));
    },
  );

  app.post<{ Params: { requestId: string }; Body: { reason?: string } }>(
    '/api/v1/admin/creator-verification/requests/:requestId/approve',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) throw new ValidationError('User is not authenticated');
      const { requestId } = request.params as { requestId: string };
      const body = ReviewSchema.parse(request.body ?? {});
      const result = await service.decideRequest(requestId, user.userId, 'approved', body.reason);
      reply.send(formatSuccess(result));
    },
  );

  app.post<{ Params: { requestId: string }; Body: { reason: string } }>(
    '/api/v1/admin/creator-verification/requests/:requestId/reject',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) throw new ValidationError('User is not authenticated');
      const { requestId } = request.params as { requestId: string };
      const body = RejectionSchema.parse(request.body);
      const result = await service.decideRequest(requestId, user.userId, 'rejected', body.reason);
      reply.send(formatSuccess(result));
    },
  );

  app.post<{ Params: { creatorId: string }; Body: { reason: string } }>(
    '/api/v1/admin/creators/:creatorId/verification/revoke',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) throw new ValidationError('User is not authenticated');
      const { creatorId } = request.params as { creatorId: string };
      const body = z.object({ reason: z.string().trim().min(1).max(2000) }).parse(request.body);
      const result = await service.unverifyCreator(creatorId, user.userId, body.reason);
      reply.send(formatSuccess(result));
    },
  );

  app.get<{ Params: { documentId: string } }>(
    '/api/v1/admin/creator-verification/documents/:documentId',
    { preHandler: requireAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { documentId } = request.params as { documentId: string };
      const document = await service.getVerificationDocument(documentId);
      reply
        .type(document.contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(document.filename)}"`)
        .send(createReadStream(document.path));
    },
  );
};