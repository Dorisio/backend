/**
 * Per-creator tier rate limiting (issue #69).
 *
 * The global limiter in src/plugins/rateLimit.ts protects the API by route
 * class; this one enforces the *tier* a creator is paying for. It is a separate
 * layer on purpose:
 *
 *   - it keys on the creator, not the caller, so a team member or an API key
 *     spends the creator's quota rather than getting a fresh bucket;
 *   - it applies two windows at once (per minute and per day), because a burst
 *     limit alone lets a script spend a day's budget in a minute;
 *   - the limit depends on live subscription state, which is not known when a
 *     route is registered.
 *
 * Counters live in process memory, alongside the existing limiter, and windows
 * are fixed rather than sliding: one counter per creator per window keeps the
 * hot path allocation free. Deployments with more than one instance should move
 * this store to Redis the same way the global limiter does.
 */

import {
  DEFAULT_CREATOR_TIER,
  getCreatorTierPlan,
  isTierAtLeast,
  type CreatorFeature,
  type CreatorTier,
} from '../config/creator-tiers';

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60_000;

export interface TierWindowState {
  windowMs: number;
  limit: number;
  used: number;
  remaining: number;
  /** ISO timestamp when this window rolls over. */
  resetsAt: string;
  exceeded: boolean;
}

export interface CreatorTierQuota {
  tier: CreatorTier;
  allowed: boolean;
  /** Which window rejected the request, when `allowed` is false. */
  scope: 'minute' | 'day' | null;
  retryAfterSeconds: number;
  minute: TierWindowState;
  day: TierWindowState;
}

interface WindowCounter {
  used: number;
  resetAt: number;
}

export interface CreatorTierLimiterOptions {
  now?: () => number;
  /** Upper bound on tracked creators, so memory cannot grow without limit. */
  maxKeys?: number;
}

export class CreatorTierLimiter {
  private readonly counters = new Map<string, WindowCounter>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: CreatorTierLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  /**
   * Spends `cost` units of a creator's quota. Returns the resulting state and
   * whether the request is allowed; a rejected request does not consume quota,
   * so a throttled client cannot extend its own lockout.
   */
  consume(creatorId: string, tier: CreatorTier, cost = 1): CreatorTierQuota {
    const plan = getCreatorTierPlan(tier);
    const nowMs = this.now();

    const minute = this.readWindow(creatorId, MINUTE_MS, plan.apiRequestsPerMinute, nowMs);
    const day = this.readWindow(creatorId, DAY_MS, plan.apiRequestsPerDay, nowMs);

    const blockedBy = minute.exceeded ? 'minute' : day.exceeded ? 'day' : null;

    if (blockedBy) {
      return {
        tier,
        allowed: false,
        scope: blockedBy,
        // Tell the client when the window that rejected them rolls over.
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(this.secondsUntil(creatorId, blockedBy === 'minute' ? MINUTE_MS : DAY_MS, nowMs))
        ),
        minute,
        day,
      };
    }

    this.writeWindow(creatorId, MINUTE_MS, nowMs, cost);
    this.writeWindow(creatorId, DAY_MS, nowMs, cost);

    return {
      tier,
      allowed: true,
      scope: null,
      retryAfterSeconds: 0,
      minute: this.readWindow(creatorId, MINUTE_MS, plan.apiRequestsPerMinute, nowMs),
      day: this.readWindow(creatorId, DAY_MS, plan.apiRequestsPerDay, nowMs),
    };
  }

  /** Current usage without spending anything. */
  peek(creatorId: string, tier: CreatorTier): CreatorTierQuota {
    const plan = getCreatorTierPlan(tier);
    const nowMs = this.now();
    const minute = this.readWindow(creatorId, MINUTE_MS, plan.apiRequestsPerMinute, nowMs);
    const day = this.readWindow(creatorId, DAY_MS, plan.apiRequestsPerDay, nowMs);
    const blockedBy = minute.exceeded ? 'minute' : day.exceeded ? 'day' : null;

    return {
      tier,
      allowed: blockedBy === null,
      scope: blockedBy,
      retryAfterSeconds: blockedBy
        ? Math.max(1, Math.ceil(this.secondsUntil(creatorId, blockedBy === 'minute' ? MINUTE_MS : DAY_MS, nowMs)))
        : 0,
      minute,
      day,
    };
  }

  /** Feature access for a tier, so callers do not re-read the config. */
  allows(tier: CreatorTier, feature: CreatorFeature): boolean {
    return getCreatorTierPlan(tier).features.includes(feature);
  }

  reset(creatorId?: string): void {
    if (!creatorId) {
      this.counters.clear();
      return;
    }
    this.counters.delete(this.key(creatorId, MINUTE_MS));
    this.counters.delete(this.key(creatorId, DAY_MS));
  }

  /** Drops expired windows. Called on a timer, not per request. */
  prune(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= nowMs) {
        this.counters.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.counters.size;
  }

  private key(creatorId: string, windowMs: number): string {
    return `${creatorId}:${windowMs}`;
  }

  private readWindow(
    creatorId: string,
    windowMs: number,
    limit: number,
    nowMs: number
  ): TierWindowState {
    const key = this.key(creatorId, windowMs);
    const counter = this.counters.get(key);
    const resetAt = counter && counter.resetAt > nowMs ? counter.resetAt : nowMs + windowMs;
    const used = counter && counter.resetAt > nowMs ? counter.used : 0;

    return {
      windowMs,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: new Date(resetAt).toISOString(),
      exceeded: used >= limit,
    };
  }

  private writeWindow(creatorId: string, windowMs: number, nowMs: number, cost: number): void {
    const key = this.key(creatorId, windowMs);
    const counter = this.counters.get(key);

    if (!counter || counter.resetAt <= nowMs) {
      this.evictIfFull();
      this.counters.set(key, { used: cost, resetAt: nowMs + windowMs });
      return;
    }

    counter.used += cost;
  }

  private secondsUntil(creatorId: string, windowMs: number, nowMs: number): number {
    const counter = this.counters.get(this.key(creatorId, windowMs));
    if (!counter) return 0;
    return Math.max(0, (counter.resetAt - nowMs) / 1000);
  }

  /** Bounded memory: drop the oldest entries rather than grow forever. */
  private evictIfFull(): void {
    if (this.counters.size < this.maxKeys) return;

    const toDrop = this.counters.size - this.maxKeys + 1;
    let dropped = 0;
    for (const key of this.counters.keys()) {
      this.counters.delete(key);
      dropped += 1;
      if (dropped >= toDrop) break;
    }
  }
}

let sharedLimiter: CreatorTierLimiter | undefined;

/** Process-wide limiter; tests construct their own instance. */
export function getCreatorTierLimiter(): CreatorTierLimiter {
  if (!sharedLimiter) sharedLimiter = new CreatorTierLimiter();
  return sharedLimiter;
}

/**
 * Standard rate-limit headers so a creator can see how much of the tier budget
 * is left before they are throttled.
 */
export function buildTierQuotaHeaders(quota: CreatorTierQuota, feature?: CreatorFeature): Record<string, string> {
  const limiting = quota.scope ?? 'minute';
  const window = limiting === 'day' ? quota.day : quota.minute;

  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(window.limit),
    'x-ratelimit-remaining': String(window.remaining),
    'x-ratelimit-reset': window.resetsAt,
    'x-ratelimit-scope': limiting,
    'x-creator-tier': quota.tier,
    'x-creator-tier-minute-limit': String(quota.minute.limit),
    'x-creator-tier-minute-remaining': String(quota.minute.remaining),
    'x-creator-tier-day-limit': String(quota.day.limit),
    'x-creator-tier-day-remaining': String(quota.day.remaining),
  };

  if (!quota.allowed) headers['retry-after'] = String(quota.retryAfterSeconds);
  if (feature) headers['x-creator-feature'] = feature;

  return headers;
}

/** Tier names that at least reach `minimum`, for error hints. */
export function tiersAtLeast(minimum: CreatorTier): CreatorTier[] {
  return (['free', 'pro', 'enterprise'] as CreatorTier[]).filter((tier) =>
    isTierAtLeast(tier, minimum)
  );
}

export { DEFAULT_CREATOR_TIER };
