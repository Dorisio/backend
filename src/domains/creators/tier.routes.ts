/**
 * Creator tier API (issue #69).
 *
 *   GET    /api/v1/creators/tier/plans          public plan catalogue
 *   GET    /api/v1/creators/me/tier             current subscription
 *   GET    /api/v1/creators/me/tier/usage       month-to-date usage vs. limits
 *   GET    /api/v1/creators/me/tier/invoices    invoice history
 *   POST   /api/v1/creators/me/tier/upgrade     move up (trial or paid)
 *   POST   /api/v1/creators/me/tier/downgrade   move down
 *   POST   /api/v1/creators/me/tier/cancel      stop at period end
 *   POST   /api/v1/creators/me/tier/resume      undo a scheduled cancellation
 *
 * Subscription reads are never rate limited: a creator that has just been
 * throttled still has to be able to fetch their plan, their limits and the
 * upgrade path so the client can show them what to do. Data reads (invoices)
 * spend tier quota like any other API request.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  CREATOR_FEATURES,
  CREATOR_TIERS,
  getCreatorTierPlan,
  type CreatorTier,
} from '../../config/creator-tiers';
import { buildTierQuotaHeaders } from '../../lib/creator-tier-limits';
import {
  enforceCreatorQuota,
  getCreatorTierContext,
  requireCreator,
} from '../../middleware/creator-tier';
import { ValidationError } from '../../utils/errors';
import { formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import {
  createCreatorTierRuntime,
  type CreatorTierRuntime,
} from './tier.runtime';
import type { CreatorBillingPeriod } from './tier.service';

const UpgradeBodySchema = z.object({
  tier: z.enum(['pro', 'enterprise']),
  billingPeriod: z.enum(['monthly', 'yearly']).optional(),
  /** Defaults to the plan's trial length; only the first paid upgrade gets one. */
  startTrial: z.boolean().optional(),
});

const DowngradeBodySchema = z.object({
  tier: z.enum(CREATOR_TIERS as unknown as [CreatorTier, ...CreatorTier[]]),
  immediate: z.boolean().optional(),
});

const CancelBodySchema = z.object({
  immediate: z.boolean().optional(),
});

const InvoicesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      'Invalid request body',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    );
  }
  return parsed.data;
}

export interface CreatorTierRoutesOptions {
  /** Reuse the process-wide runtime instead of building a new one. */
  runtime?: CreatorTierRuntime;
}

export const registerCreatorTierRoutes = (
  app: FastifyInstance,
  prisma: PrismaClient,
  options: CreatorTierRoutesOptions = {}
): CreatorTierRuntime => {
  const runtime = options.runtime ?? createCreatorTierRuntime(prisma);
  const { service, resolver, usage } = runtime;
  const ownedByCaller = requireCreator(runtime.middleware);

  // Plan catalogue: public, so pricing can be shown before signing up.
  app.get('/api/v1/creators/tier/plans', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send(
      formatSuccess({
        currency: 'usd',
        tiers: service.getPlans().map((plan) => ({
          ...plan,
          priceMonthly: plan.priceMonthlyCents / 100,
          priceYearly: plan.priceYearlyCents / 100,
        })),
        features: CREATOR_FEATURES,
      })
    );
  });

  app.get(
    '/api/v1/creators/me/tier',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.userId;
      reply.send(formatSuccess(await service.getSubscription(userId)));
    }
  );

  app.get(
    '/api/v1/creators/me/tier/usage',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const context = getCreatorTierContext(request)!;
      const summary = await usage.summary(context.creatorId, context.tier);

      reply.send(
        formatSuccess({
          ...summary,
          currentTier: context.tier,
          subscribedTier: context.subscribedTier,
          status: context.status,
          trialDaysRemaining: context.trialDaysRemaining,
          rateLimit: runtime.limiter.peek(context.creatorId, context.tier),
        })
      );
    }
  );

  app.get(
    '/api/v1/creators/me/tier/invoices',
    { preHandler: [authMiddleware, ownedByCaller, enforceCreatorQuota(runtime.middleware)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const context = getCreatorTierContext(request)!;
      const query = InvoicesQuerySchema.safeParse(request.query ?? {});
      if (!query.success) throw new ValidationError('Invalid query parameters');

      const invoices = await service.listInvoices(context.creatorId, query.data.limit);
      reply.send(formatSuccess({ invoices, count: invoices.length }));
    }
  );

  app.post(
    '/api/v1/creators/me/tier/upgrade',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseBody(UpgradeBodySchema, request.body);
      const result = await service.upgrade(request.user!.userId, {
        tier: body.tier,
        billingPeriod: body.billingPeriod as CreatorBillingPeriod | undefined,
        startTrial: body.startTrial,
      });

      // 202: a provider that needs an out-of-band payment has not activated the
      // tier yet, so the request is accepted rather than completed.
      reply.code(result.paymentRequired ? 202 : 200).send(formatSuccess(result));
    }
  );

  app.post(
    '/api/v1/creators/me/tier/downgrade',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseBody(DowngradeBodySchema, request.body);
      const subscription = await service.downgrade(request.user!.userId, {
        tier: body.tier,
        immediate: body.immediate,
      });
      reply.send(formatSuccess({ subscription }));
    }
  );

  app.post(
    '/api/v1/creators/me/tier/cancel',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseBody(CancelBodySchema, request.body);
      const subscription = await service.cancel(request.user!.userId, { immediate: body.immediate });
      reply.send(formatSuccess({ subscription }));
    }
  );

  app.post(
    '/api/v1/creators/me/tier/resume',
    { preHandler: [authMiddleware, ownedByCaller] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const subscription = await service.resume(request.user!.userId);
      reply.send(formatSuccess({ subscription }));
    }
  );

  // Exposed so other domains (analytics, API keys) can reuse the same resolver,
  // limiter and usage counters instead of building their own.
  app.decorate('creatorTiers', {
    resolver,
    limiter: runtime.limiter,
    usage,
    service,
    quotaHeaders: buildTierQuotaHeaders,
    plan: (tier: CreatorTier) => getCreatorTierPlan(tier),
  });

  return runtime;
};

declare module 'fastify' {
  interface FastifyInstance {
    creatorTiers?: {
      resolver: CreatorTierRuntime['resolver'];
      limiter: CreatorTierRuntime['limiter'];
      usage: CreatorTierRuntime['usage'];
      service: CreatorTierRuntime['service'];
      quotaHeaders: typeof buildTierQuotaHeaders;
      plan: (tier: CreatorTier) => ReturnType<typeof getCreatorTierPlan>;
    };
  }
}
