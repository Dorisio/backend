import type { IResolvers, MercuriusContext } from 'mercurius';
import type { PrismaClient } from '@prisma/client';
import { getQueueHealth } from '../lib/queue';
import { enqueueAnalytics, enqueueExport } from '../lib/jobs/enqueue';
import { UnauthorizedError } from '../utils/errors';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, sanitizePageSize } from '../utils/pagination';

export type GqlContext = {
  prisma: PrismaClient;
  user?: { userId: string; email: string; role: string };
};

/**
 * Teach Mercurius about the resolver context so the plugin registration and
 * the resolver map agree on a single context type.
 */
declare module 'mercurius' {
  interface MercuriusContext extends GqlContext {}
}

/** Clamp client supplied limits to the shared pagination bounds. */
function boundedLimit(limit?: number | null): number {
  const requested = limit ?? DEFAULT_PAGE_SIZE;
  const clamped = Math.min(Math.max(1, Math.trunc(requested) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return clamped;
}

// Projections keep GraphQL reads aligned with the declared schema and avoid
// selecting columns (and the joined `User` row) that are never serialized.
const CREATOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  bio: true,
  verified: true,
  isPublic: true,
  totalEarnings: true,
  pendingBalance: true,
  createdAt: true,
} as const;

const TIP_SELECT = {
  id: true,
  amount: true,
  message: true,
  status: true,
  transactionHash: true,
  creatorId: true,
  fromUserId: true,
  createdAt: true,
} as const;

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  verified: true,
  createdAt: true,
} as const;

export const resolvers: IResolvers<Record<string, unknown>, MercuriusContext> = {
  Query: {
    me: async (_: unknown, __: unknown, ctx: GqlContext) => {
      if (!ctx.user) return null;
      return ctx.prisma.user.findUnique({ where: { id: ctx.user.userId }, select: USER_SELECT });
    },
    creators: async (_: unknown, args: { limit?: number }, ctx: GqlContext) => {
      return ctx.prisma.creator.findMany({
        where: { isPublic: true },
        select: CREATOR_SELECT,
        take: boundedLimit(args.limit),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },
    creator: async (_: unknown, args: { username: string }, ctx: GqlContext) => {
      return ctx.prisma.creator.findUnique({
        where: { username: args.username },
        select: CREATOR_SELECT,
      });
    },
    tips: async (_: unknown, args: { creatorId?: string; limit?: number }, ctx: GqlContext) => {
      return ctx.prisma.tip.findMany({
        where: args.creatorId ? { creatorId: args.creatorId, status: 'confirmed' } : { status: 'confirmed' },
        select: TIP_SELECT,
        take: boundedLimit(args.limit),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },
    tip: async (_: unknown, args: { id: string }, ctx: GqlContext) => {
      return ctx.prisma.tip.findUnique({ where: { id: args.id }, select: TIP_SELECT });
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

export { boundedLimit, sanitizePageSize };
