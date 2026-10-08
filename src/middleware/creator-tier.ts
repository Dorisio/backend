/**
 * Creator tier middleware (issue #69).
 *
 * Three preHandlers build on one another:
 *   `requireCreator`        — the caller owns a creator profile; attaches context
 *   `enforceCreatorQuota`   — spends tier quota (per minute + per day) and sets
 *                             the rate-limit headers
 *   `requireCreatorFeature` — the tier unlocks the feature, otherwise 403 with
 *                             the upgrade path so clients can prompt
 *
 * The resolved context is kept in a WeakMap keyed by the request rather than on
 * `request` itself, so this module needs no Fastify type augmentation and a
 * context can never leak between requests.
 */

import { PrismaClient } from '@prisma/client';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_CREATOR_TIER,
  getCreatorTierPlan,
  hasCreatorFeature,
  isTierAtLeast,
  nextCreatorTier,
  resolveEffectiveTier,
  trialDaysRemaining,
  type CreatorFeature,
  type CreatorSubscriptionStatus,
  type CreatorTier,
  type CreatorTierPlan,
} from '../config/creator-tiers';
import {
  CreatorTierLimiter,
  buildTierQuotaHeaders,
  getCreatorTierLimiter,
  type CreatorTierQuota,
} from '../lib/creator-tier-limits';
import { ForbiddenError, TooManyRequestsError } from '../utils/errors';

/** Usage counters a creator accumulates during a billing period. */
export type CreatorUsageMetric = 'apiRequests' | 'analyticsQueries' | 'exports' | 'tipCount';

/**
 * Receives usage as it happens. Implemented by the usage service; kept as an
 * interface so middleware tests need no database.
 */
export interface CreatorUsageRecorder {
  increment(creatorId: string, metric: CreatorUsageMetric, amount?: number): void;
}

export interface CreatorTierContext {
  creatorId: string;
  userId: string;
  /** Tier the creator is entitled to *now* (trial expiry and lapses applied). */
  tier: CreatorTier;
  /** Tier stored on the subscription, which may be higher than `tier`. */
  subscribedTier: CreatorTier;
  plan: CreatorTierPlan;
  status: CreatorSubscriptionStatus;
  trialEndsAt: string | null;
  trialDaysRemaining: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const contexts = new WeakMap<FastifyRequest, CreatorTierContext>();

/** The context attached by `requireCreator` / `enforceCreatorQuota`, if any. */
export function getCreatorTierContext(request: FastifyRequest): CreatorTierContext | undefined {
  return contexts.get(request);
}

export interface CreatorTierResolverOptions {
  /** How long a resolved tier may be reused, in milliseconds. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Reads a creator's subscription and turns it into the tier they are entitled
 * to. Subscription rows are few and change rarely (upgrade, downgrade, renewal),
 * so results are cached briefly and invalidated explicitly when the tier
 * service writes — a tier change must take effect immediately, not after the TTL.
 */
export class CreatorTierResolver {
  private readonly cache = new Map<string, { at: number; value: CreatorTierContext | null }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly prisma: PrismaClient,
    options: CreatorTierResolverOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(userId: string): Promise<CreatorTierContext | null> {
    const cached = this.cache.get(userId);
    const nowMs = this.now();

    if (cached && nowMs - cached.at < this.ttlMs) return cached.value;

    const creator = await this.prisma.creator.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        subscription: {
          select: {
            tier: true,
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
          },
        },
      },
    });

    const value = creator ? this.buildContext(creator) : null;
    this.cache.set(userId, { at: nowMs, value });
    return value;
  }

  invalidate(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
      return;
    }
    this.cache.clear();
  }

  private buildContext(creator: {
    id: string;
    userId: string;
    subscription?: {
      tier: string;
      status: string;
      trialEndsAt: Date | null;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
    } | null;
  }): CreatorTierContext {
    const subscription = creator.subscription ?? null;
    const subscribedTier = (subscription?.tier as CreatorTier | undefined) ?? DEFAULT_CREATOR_TIER;
    const status = (subscription?.status as CreatorSubscriptionStatus | undefined) ?? 'active';
    const lifetime = subscription
      ? {
          tier: subscribedTier,
          status,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }
      : null;

    const tier = resolveEffectiveTier(lifetime);

    return {
      creatorId: creator.id,
      userId: creator.userId,
      tier,
      subscribedTier,
      plan: getCreatorTierPlan(tier),
      status,
      trialEndsAt: subscription?.trialEndsAt?.toISOString() ?? null,
      trialDaysRemaining: trialDaysRemaining(lifetime),
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    };
  }
}

export interface CreatorTierMiddlewareOptions {
  resolver: CreatorTierResolver;
  limiter?: CreatorTierLimiter;
  recorder?: CreatorUsageRecorder;
}

/**
 * Resolves the creator context, or rejects when the caller has no creator
 * profile. Also publishes `x-creator-tier*` headers so clients know where they
 * stand before hitting a limit.
 */
export function requireCreator(
  options: CreatorTierMiddlewareOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const userId = request.user?.userId;
    if (!userId) {
      throw new ForbiddenError('Authentication required');
    }

    const context = await options.resolver.resolve(userId);
    if (!context) {
      throw new ForbiddenError('A creator profile is required for this endpoint', {
        creatorProfileRequired: true,
      });
    }

    contexts.set(request, context);
    reply.header('x-creator-tier', context.tier);
    if (context.trialEndsAt) reply.header('x-creator-trial-ends-at', context.trialEndsAt);
  };
}

/**
 * Spends one unit of the creator's tier quota. Must run after `requireCreator`
 * (or resolve on its own when used as the only preHandler).
 */
export function enforceCreatorQuota(
  options: CreatorTierMiddlewareOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const limiter = options.limiter ?? getCreatorTierLimiter();

  return async (request, reply) => {
    const context = contexts.get(request) ?? (await resolveInto(request, options, reply));
    if (!context) return;

    const quota = limiter.consume(context.creatorId, context.tier);
    applyQuotaHeaders(reply, quota);

    if (!quota.allowed) {
      throw new TooManyRequestsError(
        `Your ${context.plan.name} plan allows ${context.plan.apiRequestsPerMinute} requests per minute and ${context.plan.apiRequestsPerDay} per day`,
        {
          tier: context.tier,
          scope: quota.scope,
          limit: quota.scope === 'day' ? quota.day.limit : quota.minute.limit,
          retryAfterSeconds: quota.retryAfterSeconds,
          upgradeOptions: nextCreatorTier(context.tier),
        }
      );
    }

    // API request volume feeds the month-to-date usage a creator sees.
    options.recorder?.increment(context.creatorId, 'apiRequests');
  };
}

/** Feature gate: 403 with the upgrade path when the tier does not include it. */
export function requireCreatorFeature(
  feature: CreatorFeature,
  options: CreatorTierMiddlewareOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const context = contexts.get(request) ?? (await resolveInto(request, options, reply));
    if (!context) return;

    if (!hasCreatorFeature(context.tier, feature)) {
      throw new ForbiddenError(`The ${context.plan.name} plan does not include ${feature}`, {
        feature,
        tier: context.tier,
        requiredTier: requiredTierFor(feature),
        upgradeUrl: '/api/v1/creators/me/tier/plans',
      });
    }

    reply.header('x-creator-feature', feature);
  };
}

/**
 * Resolves the creator for a request that did not run `requireCreator`.
 * Writes the context and returns it, or throws when there is no creator profile.
 */
async function resolveInto(
  request: FastifyRequest,
  options: CreatorTierMiddlewareOptions,
  reply: FastifyReply
): Promise<CreatorTierContext | undefined> {
  const userId = request.user?.userId;
  if (!userId) {
    throw new ForbiddenError('Authentication required');
  }

  const context = await options.resolver.resolve(userId);
  if (!context) {
    throw new ForbiddenError('A creator profile is required for this endpoint', {
      creatorProfileRequired: true,
    });
  }

  contexts.set(request, context);
  reply.header('x-creator-tier', context.tier);
  return context;
}

function applyQuotaHeaders(reply: FastifyReply, quota: CreatorTierQuota): void {
  for (const [name, value] of Object.entries(buildTierQuotaHeaders(quota))) {
    reply.header(name, value);
  }
}

/** Cheapest tier that unlocks a feature, for the upgrade prompt. */
export function requiredTierFor(feature: CreatorFeature): CreatorTier {
  const order: CreatorTier[] = ['free', 'pro', 'enterprise'];
  return order.find((tier) => hasCreatorFeature(tier, feature)) ?? 'enterprise';
}

export { isTierAtLeast };
