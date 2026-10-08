/**
 * Notification centre API (issue #58).
 *
 *   GET    /api/v1/notifications                     feed (filter + search + cursor)
 *   GET    /api/v1/notifications/unread-count        badge count
 *   POST   /api/v1/notifications/read                mark all read
 *   GET    /api/v1/notifications/:id                 one notification
 *   PATCH  /api/v1/notifications/:id                 mark read/unread
 *   DELETE /api/v1/notifications/:id                 dismiss
 *   GET    /api/v1/notifications/preferences         effective preference matrix
 *   PATCH  /api/v1/notifications/preferences         set one or many preferences
 *   DELETE /api/v1/notifications/preferences         reset to defaults
 *   PATCH  /api/v1/notifications/preferences/digest  digest frequency
 *   POST   /api/v1/notifications/retention/prune     admin: run the retention sweep
 *
 * The preferences GET returns the resolved matrix (every event × channel the
 * type may use, with the value and where it came from) instead of the raw
 * `User.notificationPreferences` column, which these endpoints keep in sync as a
 * projection for the email worker.
 */

import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { UnauthorizedError, ValidationError } from '../../utils/errors';
import { createNotificationCenter } from './notification-center.service';
import {
  DigestSettingsSchema,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NotificationListQuerySchema,
  PreferenceBulkSchema,
  PreferencePatchSchema,
  channelsForEvent,
  isNotificationChannel,
  retentionDaysForEvent,
  type NotificationChannel,
} from './notification.types';

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      'Invalid notification request',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    );
  }
  return parsed.data;
}

export function registerNotificationRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const { center, preferences } = createNotificationCenter(prisma);

  const requireUser = (request: { user?: { userId: string } }): string => {
    const userId = request.user?.userId;
    if (!userId) throw new UnauthorizedError('Authentication required');
    return userId;
  };

  // ── Preferences ────────────────────────────────────────────────────────────

  app.get('/api/v1/notifications/preferences', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);

    return reply.send({
      preferences: await preferences.list(userId),
      digest: await preferences.getDigest(userId),
      events: NOTIFICATION_EVENTS.map((type) => ({
        type,
        channels: channelsForEvent(type),
        retentionDays: retentionDaysForEvent(type),
      })),
    });
  });

  app.patch('/api/v1/notifications/preferences', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const body = request.body as Record<string, unknown> | undefined;

    // Two shapes: a single {eventType, channel, enabled} (what this endpoint has
    // always accepted) or {preferences: [...]} for a settings screen saving a
    // whole section at once.
    const patches =
      body && Array.isArray(body.preferences)
        ? parseOrThrow(PreferenceBulkSchema, body).preferences
        : [parseOrThrow(PreferencePatchSchema, body)];

    return reply.send({ preferences: await preferences.update(userId, patches) });
  });

  app.delete('/api/v1/notifications/preferences', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    return reply.send({ preferences: await preferences.reset(userId) });
  });

  app.patch('/api/v1/notifications/preferences/digest', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const input = parseOrThrow(DigestSettingsSchema, request.body ?? {});

    return reply.send({ digest: await preferences.setDigest(userId, input) });
  });

  // ── Notification centre ────────────────────────────────────────────────────

  app.get('/api/v1/notifications', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const query = parseOrThrow(NotificationListQuerySchema, request.query ?? {});

    return reply.send(await center.list(userId, query));
  });

  app.get('/api/v1/notifications/unread-count', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const query = (request.query ?? {}) as { channel?: unknown };
    const channel: NotificationChannel | undefined = isNotificationChannel(query.channel)
      ? query.channel
      : undefined;

    if (query.channel !== undefined && !channel) {
      throw new ValidationError('Invalid notification channel');
    }

    return reply.send({ unread: await center.unreadCount(userId, channel) });
  });

  app.post<{ Body: { type?: string; channel?: string } }>(
    '/api/v1/notifications/read',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      const body = request.body ?? {};

      if (body.channel !== undefined && !isNotificationChannel(body.channel)) {
        throw new ValidationError('Invalid notification channel');
      }

      return reply.send(
        await center.markAllRead(userId, {
          ...(body.type ? { type: body.type } : {}),
          ...(body.channel ? { channel: body.channel } : {}),
        })
      );
    }
  );

  app.post('/api/v1/notifications/retention/prune', { preHandler: requireAdmin }, async (_request, reply) => {
    return reply.send(await center.pruneExpired());
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/notifications/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      return reply.send({ notification: await center.get(userId, request.params.id) });
    }
  );

  app.patch<{ Params: { id: string }; Body: { read?: boolean } }>(
    '/api/v1/notifications/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      const read = request.body?.read ?? true;
      if (typeof read !== 'boolean') throw new ValidationError('read must be a boolean');

      return reply.send({ notification: await center.markRead(userId, request.params.id, read) });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/notifications/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      await center.remove(userId, request.params.id);
      return reply.code(204).send();
    }
  );
}
