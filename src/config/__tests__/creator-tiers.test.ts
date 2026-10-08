import { describe, it, expect } from 'vitest';
import {
  CREATOR_TIERS,
  DEFAULT_CREATOR_TIER,
  buildUpgradeOptions,
  getCreatorTierPlan,
  hasCreatorFeature,
  isCreatorTier,
  isPaidCreatorTier,
  isTierAtLeast,
  listCreatorTierPlans,
  nextCreatorTier,
  prorateTierChangeCents,
  previousCreatorTier,
  remainingQuota,
  resolveEffectiveTier,
  trialDaysRemaining,
} from '../creator-tiers';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 8, 27, 12, 0, 0));

describe('creator tier plans', () => {
  it('publishes every tier with increasing limits and features', () => {
    const plans = listCreatorTierPlans();

    expect(plans.map((plan) => plan.tier)).toEqual([...CREATOR_TIERS]);
    expect(plans[0].priceMonthlyCents).toBe(0);
    expect(isPaidCreatorTier('free')).toBe(false);
    expect(isPaidCreatorTier('pro')).toBe(true);

    for (let i = 1; i < plans.length; i += 1) {
      expect(plans[i].apiRequestsPerMinute).toBeGreaterThan(plans[i - 1].apiRequestsPerMinute);
      expect(plans[i].apiRequestsPerDay).toBeGreaterThan(plans[i - 1].apiRequestsPerDay);
      expect(plans[i].monthlyExports).toBeGreaterThan(plans[i - 1].monthlyExports);
      expect(plans[i].analyticsHistoryDays).toBeGreaterThan(plans[i - 1].analyticsHistoryDays);
    }
  });

  it('gates features per tier', () => {
    expect(hasCreatorFeature('free', 'analytics_export')).toBe(false);
    expect(hasCreatorFeature('pro', 'analytics_export')).toBe(true);
    expect(hasCreatorFeature('pro', 'custom_branding')).toBe(false);
    expect(hasCreatorFeature('enterprise', 'custom_branding')).toBe(true);
    expect(hasCreatorFeature('enterprise', 'priority_support')).toBe(true);
  });

  it('orders tiers and resolves neighbours', () => {
    expect(isTierAtLeast('enterprise', 'pro')).toBe(true);
    expect(isTierAtLeast('pro', 'enterprise')).toBe(false);
    expect(isTierAtLeast('free', 'free')).toBe(true);

    expect(nextCreatorTier('free')).toBe('pro');
    expect(nextCreatorTier('enterprise')).toBeNull();
    expect(previousCreatorTier('pro')).toBe('free');
    expect(previousCreatorTier('free')).toBeNull();
  });

  it('rejects unknown tiers and falls back to the free plan', () => {
    expect(isCreatorTier('pro')).toBe(true);
    expect(isCreatorTier('platinum')).toBe(false);
    expect(getCreatorTierPlan('platinum' as never).tier).toBe(DEFAULT_CREATOR_TIER);
  });
});

describe('resolveEffectiveTier', () => {
  it('returns free without a subscription', () => {
    expect(resolveEffectiveTier(null, NOW)).toBe('free');
  });

  it('keeps a paid tier while the trial runs and drops it afterwards', () => {
    const trialing = {
      tier: 'pro' as const,
      status: 'trialing' as const,
      trialEndsAt: new Date(NOW.getTime() + DAY_MS),
    };

    expect(resolveEffectiveTier(trialing, NOW)).toBe('pro');
    expect(trialDaysRemaining(trialing, NOW)).toBe(1);

    const expiredTrial = { ...trialing, trialEndsAt: new Date(NOW.getTime() - DAY_MS) };
    expect(resolveEffectiveTier(expiredTrial, NOW)).toBe('free');
    expect(trialDaysRemaining(expiredTrial, NOW)).toBe(0);
  });

  it('keeps access until the paid period ends after cancellation', () => {
    const canceled = {
      tier: 'enterprise' as const,
      status: 'canceled' as const,
      currentPeriodEnd: new Date(NOW.getTime() + DAY_MS),
    };

    expect(resolveEffectiveTier(canceled, NOW)).toBe('enterprise');
    expect(
      resolveEffectiveTier({ ...canceled, currentPeriodEnd: new Date(NOW.getTime() - 1) }, NOW)
    ).toBe('free');
  });

  it('does not downgrade a past-due creator and expires immediately once expired', () => {
    expect(resolveEffectiveTier({ tier: 'pro', status: 'past_due' }, NOW)).toBe('pro');
    expect(resolveEffectiveTier({ tier: 'pro', status: 'expired' }, NOW)).toBe('free');
    expect(
      resolveEffectiveTier({ tier: 'pro', status: 'active' }, NOW)
    ).toBe('pro');
  });
});

describe('tier pricing helpers', () => {
  it('prices upgrades with the time left in the paid period', () => {
    // Half a month left on Pro: half of the Enterprise monthly price.
    expect(prorateTierChangeCents('pro', 'enterprise', new Date(NOW.getTime() + 15 * DAY_MS), NOW)).toBe(4_950);
    // Downgrades cost nothing now.
    expect(prorateTierChangeCents('enterprise', 'pro', new Date(NOW.getTime() + 15 * DAY_MS), NOW)).toBe(0);
  });

  it('lists the upgrade path with the amount owed', () => {
    const options = buildUpgradeOptions('pro', new Date(NOW.getTime() + 30 * DAY_MS), NOW);

    expect(options.map((option) => option.tier)).toEqual(['enterprise']);
    expect(options[0].priceMonthlyCents).toBe(9_900);
    expect(options[0].amountDueCents).toBeGreaterThan(0);
  });

  it('computes the quota a creator has left', () => {
    expect(remainingQuota(25, 5)).toBe(20);
    expect(remainingQuota(25, 30)).toBe(0);
  });
});
