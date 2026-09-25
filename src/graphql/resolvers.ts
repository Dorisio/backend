import type { PrismaClient } from '@prisma/client';
import { getQueueHealth } from '../lib/queue';
import { enqueueAnalytics, enqueueExport } from '../lib/jobs/enqueue';
import { UnauthorizedError } from '../utils/errors';

export type GqlContext = {
  prisma: PrismaClient;
  user?: { userId: string; email: string; role: string };
};

export const resolvers = {
  Query: {
    me: async (_: unknown, __: unknown, ctx: GqlContext) => {
      if (!ctx.user) return null;
      return ctx.prisma.user.findUnique({ where: { id: ctx.user.userId } });
    },
    creators: async (_: unknown, args: { limit?: number }, ctx: GqlContext) => {
      return ctx.prisma.creator.findMany({
        where: { isPublic: true },
        take: Math.min(args.limit ?? 20, 100),
        orderBy: { createdAt: 'desc' },
      });
    },
    creator: async (_: unknown, args: { username: string }, ctx: GqlContext) => {
      return ctx.prisma.creator.findUnique({ where: { username: args.username } });
    },
    tips: async (_: unknown, args: { creatorId?: string; limit?: number }, ctx: GqlContext) => {
      return ctx.prisma.tip.findMany({
        where: args.creatorId ? { creatorId: args.creatorId } : undefined,
        take: Math.min(args.limit ?? 20, 100),
        orderBy: { createdAt: 'desc' },
      });
    },
    tip: async (_: unknown, args: { id: string }, ctx: GqlContext) => {
      return ctx.prisma.tip.findUnique({ where: { id: args.id } });
    },
    queueHealth: async () => getQueueHealth(),
  },
  Mutation: {
    enqueueAnalytics: async (
      _: unknown,
      args: { creatorId: string; rangeDays?: number },
      ctx: GqlContext,
    ) => {
      if (!ctx.user) throw new UnauthorizedError('Authentication required');
      const job = await enqueueAnalytics({
        creatorId: args.creatorId,
        rangeDays: args.rangeDays,
      });
      return { id: job.id, queue: job.queueName, name: job.name };
    },
    enqueueExport: async (
      _: unknown,
      args: { type: 'tips' | 'payouts' | 'analytics'; format?: 'csv' | 'json' },
      ctx: GqlContext,
    ) => {
      if (!ctx.user) throw new UnauthorizedError('Authentication required');
      const job = await enqueueExport({
        userId: ctx.user.userId,
        type: args.type,
        format: args.format,
      });
      return { id: job.id, queue: job.queueName, name: job.name };
    },
  },
};
