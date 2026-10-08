import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import { formatError, formatSuccess } from '../../types/response';
import { logger } from '../../utils/logger';

type ExportRow = { id: string; createdAt: string; email?: string | null; name?: string | null };

function csv(rows: ExportRow[]): string {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [['id', 'created_at', 'email', 'name'], ...rows.map((row) => [row.id, row.createdAt, row.email, row.name])]
    .map((row) => row.map(escape).join(','))
    .join('\n') + '\n';
}

export function registerPrivacyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.get<{ Querystring: { format?: 'json' | 'csv' } }>(
    '/api/v1/privacy/export',
    { preHandler: authMiddleware },
    async (request: FastifyRequest<{ Querystring: { format?: 'json' | 'csv' } }>, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
      const user = await prisma.user.findUnique({
        where: { id: request.user.userId },
        include: { wallets: true, creator: true, tips: true, payments: true },
      });
      if (!user) return reply.code(404).send(formatError('User not found', 'USER_NOT_FOUND'));
      const data = { exportedAt: new Date().toISOString(), user, wallets: user.wallets, tips: user.tips, payments: user.payments };
      if (request.query.format === 'csv') {
        const rows = [
          { id: user.id, createdAt: user.createdAt.toISOString(), email: user.email, name: user.name },
          ...user.tips.map((tip) => ({ id: tip.id, createdAt: tip.createdAt.toISOString(), email: null, name: `tip:${tip.status}` })),
        ];
        return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="dorisio-data-export.csv"').send(csv(rows));
      }
      return reply.send(formatSuccess(data));
    },
  );

  app.delete('/api/v1/privacy/account', { preHandler: authMiddleware }, async (request, reply) => {
    if (!request.user) return reply.code(401).send(formatError('Unauthorized', 'UNAUTHORIZED'));
    const user = await prisma.user.findUnique({ where: { id: request.user.userId }, select: { id: true } });
    if (!user) return reply.code(404).send(formatError('User not found', 'USER_NOT_FOUND'));
    const tombstone = `deleted-${randomUUID()}@privacy.invalid`;
    await prisma.user.update({
      where: { id: user.id },
      data: { email: tombstone, password: randomUUID(), name: null, verified: false, notificationPreferences: {} },
    });
    await prisma.wallet.deleteMany({ where: { userId: user.id } });
    logger.info({ userId: user.id }, 'user privacy deletion completed');
    return reply.send(formatSuccess({ deleted: true }));
  });
}
