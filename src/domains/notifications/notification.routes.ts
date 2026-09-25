import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError } from '../../utils/errors';

const channels = new Set(['email', 'sms', 'push']);

export function registerNotificationRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get('/api/v1/notifications/preferences', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = request.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
    if (!user) return reply.code(404).send({ error: 'User not found' });
    return { preferences: user.notificationPreferences };
  });

  app.patch<{ Body: { eventType: string; channel: string; enabled: boolean } }>(
    '/api/v1/notifications/preferences',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = request.user?.userId;
      const { eventType, channel, enabled } = request.body ?? {};
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
      if (!eventType || !/^[a-z][a-z0-9_.-]{1,63}$/i.test(eventType) || !channels.has(channel) || typeof enabled !== 'boolean') {
        throw new ValidationError('eventType, a supported channel, and enabled are required');
      }
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
      if (!user) return reply.code(404).send({ error: 'User not found' });
      const current = user.notificationPreferences as Record<string, Record<string, boolean>>;
      const preferences = { ...current, [eventType]: { ...current[eventType], [channel]: enabled } };
      await prisma.user.update({ where: { id: userId }, data: { notificationPreferences: preferences } });
      return { preferences };
    },
  );
}
