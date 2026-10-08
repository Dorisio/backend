/**
 * Tip media API (issue #64).
 *
 *   POST   /api/v1/media/uploads                    reserve a slot, get an upload target
 *   PUT    /api/v1/media/uploads/:mediaId/content    proxy upload (MEDIA_UPLOAD_MODE=proxy)
 *   POST   /api/v1/media/uploads/:mediaId/complete   verify, scan and commit to quota
 *   GET    /api/v1/media/quota                       current usage
 *   GET    /api/v1/media                             my uploads (status/kind/attached filters)
 *   GET    /api/v1/media/:mediaId                    one upload (owner)
 *   GET    /api/v1/media/:mediaId/content            bytes: owner, or anyone for an attached tip
 *   DELETE /api/v1/media/:mediaId                    delete an unattached upload
 *   POST   /api/v1/media/maintenance/prune           admin: close abandoned uploads
 *
 * Attaching happens at tip creation time (`mediaIds` on POST
 * /api/v1/transactions/tip), so an upload can never be attached by a third party.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware, optionalAuthMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors';
import { config } from '../../config/env';
import { createMediaStack } from './media.factory';
import {
  MediaListQuerySchema,
  RequestUploadSchema,
  UploadContentSchema,
} from './media.types';
import type { MediaDerivative } from './media.types';

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Invalid media request', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data as z.output<S>;
}

function requireUser(request: { user?: { userId: string } }): string {
  const userId = request.user?.userId;
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

export function registerMediaRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const { service, storage } = createMediaStack(prisma);

  // The proxy path carries the file as base64 JSON, so the body limit has to cover
  // the base64 expansion of the largest allowed video.
  const proxyBodyLimit = Math.ceil(config.MEDIA_MAX_VIDEO_BYTES * 1.4) + 1024;

  app.post('/api/v1/media/uploads', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const input = parseOrThrow(RequestUploadSchema, request.body);

    const result = await service.requestUpload(userId, input);
    return reply.code(201).send(result);
  });

  app.put<{ Params: { mediaId: string } }>(
    '/api/v1/media/uploads/:mediaId/content',
    { preHandler: authMiddleware, bodyLimit: proxyBodyLimit },
    async (request, reply) => {
      const userId = requireUser(request);
      const body = parseOrThrow(UploadContentSchema, request.body ?? {});
      const buffer = Buffer.from(body.content, 'base64');
      if (buffer.byteLength === 0) {
        throw new ValidationError('content is empty or is not valid base64');
      }

      const media = await service.writeUploadedContent(userId, request.params.mediaId, buffer);
      return reply.code(200).send({ media });
    }
  );

  app.post<{ Params: { mediaId: string } }>(
    '/api/v1/media/uploads/:mediaId/complete',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      const media = await service.completeUpload(userId, request.params.mediaId);
      return reply.send({ media });
    }
  );

  app.get('/api/v1/media/quota', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    return reply.send({ quota: await service.getQuota(userId) });
  });

  app.get('/api/v1/media', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const query = parseOrThrow(MediaListQuerySchema, request.query ?? {});
    return reply.send(await service.listMine(userId, query));
  });

  app.get<{ Params: { mediaId: string } }>(
    '/api/v1/media/:mediaId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      return reply.send({ media: await service.getMedia(userId, request.params.mediaId) });
    }
  );

  /**
   * Bytes. With `MEDIA_STORAGE=s3` this redirects to a short-lived presigned URL so
   * the API never proxies the file; the local adapter streams it. A CDN base URL
   * makes this route unnecessary for public media, but it still serves owners of
   * media that is not attached to anything yet.
   */
  app.get<{ Params: { mediaId: string }; Querystring: { variant?: string } }>(
    '/api/v1/media/:mediaId/content',
    { preHandler: optionalAuthMiddleware },
    async (request: FastifyRequest<{ Params: { mediaId: string }; Querystring: { variant?: string } }>, reply: FastifyReply) => {
      const viewerId = request.user?.userId ?? null;
      const media = await service.findById(request.params.mediaId);
      if (!media) throw new NotFoundError('Media');
      if (!(await service.canRead(viewerId, media))) throw new NotFoundError('Media');

      const derivatives = Array.isArray(media.derivatives) ? (media.derivatives as MediaDerivative[]) : [];
      const requested = request.query?.variant;
      const derivative = requested ? derivatives.find((entry) => entry.variant === requested) : undefined;
      if (requested && !derivative) throw new NotFoundError('Media variant');

      const key = derivative?.key ?? media.storageKey;
      const contentType = derivative?.mimeType ?? media.mimeType;

      if (storage.kind === 's3') {
        const url = await storage.createDownloadUrl({ key, ttlSeconds: 300 });
        // Fastify v5 signature: (url, statusCode).
        return reply.redirect(url, 302);
      }

      const object = await storage.getObject(key);
      return reply
        .header('content-type', contentType)
        .header('content-length', String(object.sizeBytes))
        .header('cache-control', media.tipId ? 'public, max-age=3600' : 'private, max-age=300')
        .send(object.body);
    }
  );

  app.delete<{ Params: { mediaId: string } }>(
    '/api/v1/media/:mediaId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      await service.deleteMedia(userId, request.params.mediaId);
      return reply.code(204).send();
    }
  );

  app.post('/api/v1/media/maintenance/prune', { preHandler: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as { olderThanMinutes?: number };
    const olderThanMinutes =
      typeof body.olderThanMinutes === 'number' && body.olderThanMinutes > 0
        ? Math.min(body.olderThanMinutes, 60 * 24 * 30)
        : 60 * 24;

    return reply.send(await service.pruneStaleUploads(olderThanMinutes));
  });
}
