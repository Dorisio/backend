/**
 * Creator subscription tiers (issue #69).
 *
 * This is the single source of truth for what each tier gets: rate limits,
 * feature access, pricing and trial length. Routes, middleware and the billing
 * service all read the plan from here, so a limit can never drift between the
 * documentation, the enforcement point and the invoices.
 */

export const CREATOR_TIERS = ['free', 'pro', 'enterprise'] as const;

export type CreatorTier = (typeof CREATOR_TIERS)[number];

/** Features a plan can unlock. Values are the names used in API responses. */
export const CREATOR_FEATURES = [
  'analytics_export',
  'advanced_analytics',
  'team_members',
  'api_access',
  'webhooks',
  'priority_support',
  'custom_branding',
] as const;

export type CreatorFeature = (typeof CREATOR_FEATURES)[number];

export type CreatorSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired';

export interface CreatorTierPlan {
  tier: CreatorTier;
  name: string;
  description: string;
  /** Price in the smallest currency unit, so proration and invoices stay exact. */
  priceMonthlyCents: number;
  priceYearlyCents: number;
  /** Length of the free trial granted when a creator starts a paid tier. */
  trialDays: number;
  /** API requests allowed per rolling minute for a single creator. */
  apiRequestsPerMinute: number;
  /** API requests allowed per rolling day for a single creator. */
  apiRequestsPerDay: number;
  /** How far back the creator may query analytics. */
  analyticsHistoryDays: number;
  /** How many people may access the creator account in total (owner included). */
  maxTeamMembers: number;
  /** Data exports allowed per calendar month. */
  monthlyExports: number;
  features: CreatorFeature[];
}

/**
 * Limits are per creator, not per user: a whale creator tipping from a fan
 * account is not what throttles the dashboard or the public API.
 */
export const CREATOR_TIER_PLANS: Record<CreatorTier, CreatorTierPlan> = {
  free: {
    tier: 'free',
    name: 'Free',
    description: 'Everything needed to publish a profile and receive tips.',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    trialDays: 0,
    apiRequestsPerMinute: 60,
    apiRequestsPerDay: 5_000,
    analyticsHistoryDays: 30,
    maxTeamMembers: 1,
    monthlyExports: 1,
    features: [],
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    description: 'Deeper analytics, exports, API access and a small team.',
    priceMonthlyCents: 1_900,
    priceYearlyCents: 19_000,
    trialDays: 14,
    apiRequestsPerMinute: 300,
    apiRequestsPerDay: 50_000,
    analyticsHistoryDays: 365,
    maxTeamMembers: 5,
    monthlyExports: 25,
    features: ['advanced_analytics', 'analytics_export', 'team_members', 'api_access'],
  },
  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'High-volume API access, webhooks, branding and priority support.',
    priceMonthlyCents: 9_900,
    priceYearlyCents: 99_000,
    trialDays: 14,
    apiRequestsPerMinute: 1_500,
    apiRequestsPerDay: 500_000,
    analyticsHistoryDays: 1_095,
    maxTeamMembers: 25,
    monthlyExports: 500,
    features: [
      'advanced_analytics',
      'analytics_export',
      'team_members',
      'api_access',
      'webhooks',
      'priority_support',
      'custom_branding',
    ],
  },
};

export const DEFAULT_CREATOR_TIER: CreatorTier = 'free';

/** Tiers a creator can pay for, cheapest first. */
export const PAID_CREATOR_TIERS: CreatorTier[] = ['pro', 'enterprise'];

const TIER_RANK: Record<CreatorTier, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

export function isCreatorTier(value: unknown): value is CreatorTier {
  return typeof value === 'string' && (CREATOR_TIERS as readonly string[]).includes(value);
}

export function isCreatorFeature(value: unknown): value is CreatorFeature {
  return typeof value === 'string' && (CREATOR_FEATURES as readonly string[]).includes(value);
}

export function creatorTierRank(tier: CreatorTier): number {
  return TIER_RANK[tier];
}

export function isTierAtLeast(tier: CreatorTier, minimum: CreatorTier): boolean {
  return creatorTierRank(tier) >= creatorTierRank(minimum);
}

export function getCreatorTierPlan(tier: CreatorTier): CreatorTierPlan {
  return CREATOR_TIER_PLANS[tier] ?? CREATOR_TIER_PLANS[DEFAULT_CREATOR_TIER];
}

export function listCreatorTierPlans(): CreatorTierPlan[] {
  return CREATOR_TIERS.map((tier) => CREATOR_TIER_PLANS[tier]);
}

export function nextCreatorTier(tier: CreatorTier): CreatorTier | null {
  return CREATOR_TIERS[creatorTierRank(tier) + 1] ?? null;
}

export function previousCreatorTier(tier: CreatorTier): CreatorTier | null {
  const rank = creatorTierRank(tier);
  return rank > 0 ? CREATOR_TIERS[rank - 1] : null;
}

export function hasCreatorFeature(tier: CreatorTier, feature: CreatorFeature): boolean {
  return getCreatorTierPlan(tier).features.includes(feature);
}

export function isPaidCreatorTier(tier: CreatorTier): boolean {
  return tier !== DEFAULT_CREATOR_TIER;
}

export interface SubscriptionLifetime {
  tier: CreatorTier;
  status: CreatorSubscriptionStatus;
  trialEndsAt?: string | Date | null;
  currentPeriodEnd?: string | Date | null;
}

function toTimestamp(value: string | Date | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * The tier a creator is actually entitled to right now.
 *
 * Stored tier and entitled tier differ whenever a subscription lapses:
 *   - `trialing` keeps the paid tier until the trial ends, then falls to free.
 *   - `canceled` keeps the paid tier until the paid period ends (access is
 *     already paid for), then falls to free.
 *   - `past_due` keeps the paid tier while the payment retry window is open —
 *     downgrading on the first failed charge would break a paying customer.
 *   - `expired` falls to free immediately.
 */
export function resolveEffectiveTier(
  subscription: SubscriptionLifetime | null | undefined,
  now: Date = new Date()
): CreatorTier {
  if (!subscription || !isCreatorTier(subscription.tier)) return DEFAULT_CREATOR_TIER;

  const nowMs = now.getTime();
  const tier = subscription.tier;

  switch (subscription.status) {
    case 'active':
    case 'past_due':
      return tier;
    case 'trialing':
      return toTimestamp(subscription.trialEndsAt, nowMs) > nowMs ? tier : DEFAULT_CREATOR_TIER;
    case 'canceled':
      return toTimestamp(subscription.currentPeriodEnd, nowMs) > nowMs ? tier : DEFAULT_CREATOR_TIER;
    case 'expired':
    default:
      return DEFAULT_CREATOR_TIER;
  }
}

export function isTrialActive(
  subscription: SubscriptionLifetime | null | undefined,
  now: Date = new Date()
): boolean {
  if (!subscription || subscription.status !== 'trialing') return false;
  return toTimestamp(subscription.trialEndsAt, 0) > now.getTime();
}

/** Whole days left in a trial, or 0 when there is no active trial. */
export function trialDaysRemaining(
  subscription: SubscriptionLifetime | null | undefined,
  now: Date = new Date()
): number {
  if (!isTrialActive(subscription, now)) return 0;

  const endMs = toTimestamp(subscription.trialEndsAt, now.getTime());
  return Math.max(0, Math.ceil((endMs - now.getTime()) / (24 * 60 * 60 * 1000)));
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / (24 * 60 * 60 * 1000));
}

/**
 * Amount owed to move from one tier to another:
 *   - upgrades are prorated for the remaining days of the current period, so a
 *     creator upgrading mid-cycle is not charged twice for the same days;
 *   - downgrades cost nothing now — the lower tier starts at the next period.
 */
export function prorateTierChangeCents(
  from: CreatorTier,
  to: CreatorTier,
  periodEnd: string | Date | null | undefined,
  now: Date = new Date()
): number {
  if (creatorTierRank(to) <= creatorTierRank(from)) return 0;

  const periodEndMs = toTimestamp(periodEnd, now.getTime());
  const remainingDays = daysBetween(now.getTime(), periodEndMs);
  const dailyCents = getCreatorTierPlan(to).priceMonthlyCents / 30;

  return Math.max(0, Math.round(dailyCents * Math.min(remainingDays, 30)));
}

export interface TierUpgradeOption {
  tier: CreatorTier;
  name: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  amountDueCents: number;
  trialDays: number;
  features: CreatorFeature[];
}

/** What the creator can move to from where they are, priced for this period. */
export function buildUpgradeOptions(
  currentTier: CreatorTier,
  periodEnd?: string | Date | null,
  now: Date = new Date()
): TierUpgradeOption[] {
  return CREATOR_TIERS.filter((tier) => creatorTierRank(tier) > creatorTierRank(currentTier)).map(
    (tier) => {
      const plan = getCreatorTierPlan(tier);
      return {
        tier,
        name: plan.name,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceYearlyCents: plan.priceYearlyCents,
        amountDueCents: prorateTierChangeCents(currentTier, tier, periodEnd, now),
        trialDays: plan.trialDays,
        features: plan.features,
      };
    }
  );
}

/**
 * Whether a creator may still act on `metric` for the current period.
 * `usage` is month-to-date, `limit` comes from the plan.
 */
export function remainingQuota(limit: number, usage: number): number {
  return Math.max(0, limit - usage);
}

export function isQuotaExhausted(limit: number, usage: number): boolean {
  return usage >= limit;
}
