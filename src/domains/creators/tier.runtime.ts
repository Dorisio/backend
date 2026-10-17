/**
 * Shared runtime for creator tier enforcement (issue #69).
 *
 * One instance per process wires the pieces together so that every feature —
 * the tier routes, the analytics endpoints, background renewal — sees the same
 * cache, the same limiter and the same buffered usage counters:
 *
 *   - `resolver`  turns a user id into the tier they are entitled to and is
 *                 invalidated whenever a subscription write goes through;
 *   - `limiter`   enforces the per-creator minute/day budget;
 *   - `usage`     buffers month-to-date counters and flushes them in batches;
 *   - `service`   owns the subscription state machine and invoices.
 *
 * Building it here (rather than inside a route module) is what keeps tier
 * changes from being visible on one endpoint and invisible on another.
 */

import { PrismaClient } from '@prisma/client';
import { CreatorTierLimiter, getCreatorTierLimiter } from '../../lib/creator-tier-limits';
import { CreatorTierResolver, type CreatorTierMiddlewareOptions } from '../../middleware/creator-tier';
import { CreatorTierService, CreatorUsageService } from './tier.service';
import type { CreatorTier } from '../../config/creator-tiers';

export interface TierPayoutThreshold {
  minEarnings: number;
  minFollowers: number;
  feeRate: number; // e.g. 0.10 for free, 0.05 for pro, 0.02 for enterprise
  name: string;
}

export const TIER_PAYOUT_THRESHOLDS: Record<CreatorTier, TierPayoutThreshold> = {
  free: {
    minEarnings: 0,
    minFollowers: 0,
    feeRate: 0.10, // 10% standard/default lowest tier fee
    name: 'Free',
  },
  pro: {
    minEarnings: 1000,
    minFollowers: 100,
    feeRate: 0.05, // 5% discounted fee
    name: 'Pro',
  },
  enterprise: {
    minEarnings: 10000,
    minFollowers: 1000,
    feeRate: 0.02, // 2% premium fee
    name: 'Enterprise',
  },
};

/**
 * Calculates the tier a creator qualifies for based on earnings and optional follower count.
 */
export function getTierFor(earnings: number, followerCount?: number): CreatorTier {
  if (
    earnings >= TIER_PAYOUT_THRESHOLDS.enterprise.minEarnings &&
    (followerCount === undefined || followerCount >= TIER_PAYOUT_THRESHOLDS.enterprise.minFollowers)
  ) {
    return 'enterprise';
  }
  if (
    earnings >= TIER_PAYOUT_THRESHOLDS.pro.minEarnings &&
    (followerCount === undefined || followerCount >= TIER_PAYOUT_THRESHOLDS.pro.minFollowers)
  ) {
    return 'pro';
  }
  return 'free';
}

/**
 * Checks whether a creator meets the minimum earnings and follower thresholds for a tier.
 */
export function isEligibleForTier(
  tier: CreatorTier,
  earnings: number,
  followerCount: number = 0
): boolean {
  const threshold = TIER_PAYOUT_THRESHOLDS[tier];
  if (!threshold) return false;
  return earnings >= threshold.minEarnings && followerCount >= threshold.minFollowers;
}

export function getFeeRateForTier(tier: CreatorTier): number {
  return TIER_PAYOUT_THRESHOLDS[tier]?.feeRate ?? TIER_PAYOUT_THRESHOLDS.free.feeRate;
}

export const creatorTiers = {
  getTierFor,
  isEligibleForTier,
  getFeeRateForTier,
  thresholds: TIER_PAYOUT_THRESHOLDS,
};

export interface CreatorTierRuntime {
  resolver: CreatorTierResolver;
  limiter: CreatorTierLimiter;
  usage: CreatorUsageService;
  service: CreatorTierService;
  /** Options bundle for `requireCreator` / `enforceCreatorQuota`. */
  middleware: CreatorTierMiddlewareOptions;
  /** Calculates the tier threshold a creator qualifies for. */
  getTierFor(earnings: number, followerCount?: number): CreatorTier;
  /** Verifies if creator meets earnings and follower requirements for the specified tier. */
  isEligibleForTier(tier: CreatorTier, earnings: number, followerCount?: number): boolean;
  /** Returns the fee rate for a given tier. */
  getFeeRateForTier(tier: CreatorTier): number;
  /** Tier payout thresholds. */
  thresholds: Record<CreatorTier, TierPayoutThreshold>;
  /** Flushes buffered usage and stops timers. Safe to call more than once. */
  close(): Promise<void>;
}

export interface CreatorTierRuntimeOptions {
  /** Reuse an existing limiter (tests, or a Redis-backed replacement). */
  limiter?: CreatorTierLimiter;
  /** How often buffered usage is written to the database. */
  usageFlushIntervalMs?: number;
  /** How often expired rate-limit windows are dropped. */
  pruneIntervalMs?: number;
  /** Longest a resolved tier may be reused, in milliseconds. */
  resolverTtlMs?: number;
  now?: () => number;
  /** Set to false in tests to flush usage explicitly. */
  autoFlushUsage?: boolean;
  /** Set to false in tests to prune explicitly. */
  autoPrune?: boolean;
}

export function createCreatorTierRuntime(
  prisma: PrismaClient,
  options: CreatorTierRuntimeOptions = {}
): CreatorTierRuntime {
  const limiter = options.limiter ?? getCreatorTierLimiter();
  const resolver = new CreatorTierResolver(prisma, {
    ttlMs: options.resolverTtlMs,
    now: options.now,
  });

  const usage = new CreatorUsageService(prisma, {
    now: options.now,
    flushIntervalMs: options.usageFlushIntervalMs,
    autoFlush: options.autoFlushUsage,
  });

  const service = new CreatorTierService(prisma, {
    now: options.now,
    // A tier change must be visible on the very next request, so the cached
    // tier for that user is dropped instead of waiting for the TTL.
    onTierChanged: (userId) => resolver.invalidate(userId),
  });

  const pruneTimer =
    options.autoPrune === false
      ? null
      : setInterval(() => limiter.prune(), options.pruneIntervalMs ?? 5 * 60_000);
  // Never keep the process alive just to prune counters.
  pruneTimer?.unref?.();

  let closed = false;

  return {
    resolver,
    limiter,
    usage,
    service,
    middleware: { resolver, limiter, recorder: usage },
    getTierFor,
    isEligibleForTier,
    getFeeRateForTier,
    thresholds: TIER_PAYOUT_THRESHOLDS,
    async close() {
      if (closed) return;
      closed = true;
      if (pruneTimer) clearInterval(pruneTimer);
      // Buffered counters are usage data the creator may have paid for; lose as
      // little of it as possible on shutdown.
      await usage.flush().catch(() => undefined);
      usage.stop();
    },
  };
}
