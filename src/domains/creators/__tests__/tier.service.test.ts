import { describe, it, expect } from 'vitest';
import { FakeTierPrisma, asPrisma } from './fake-tier-prisma';
import {
  CreatorTierService,
  CreatorUsageService,
  usagePeriodKey,
  type TierBillingProvider,
} from '../tier.service';

const DAY_MS = 24 * 60 * 60 * 1000;

const paidProvider: TierBillingProvider = {
  name: 'test-psp',
  async charge() {
    return { status: 'paid', providerInvoiceId: 'pi_1', providerSubscriptionId: 'psp_sub_1' };
  },
};

function build(nowMs: number, billing?: TierBillingProvider) {
  const fake = new FakeTierPrisma();
  const creator = fake.seedCreator({ userId: 'user_1' });
  const service = new CreatorTierService(asPrisma(fake), { now: () => nowMs, billing });
  return { fake, creator, service, nowMs };
}

describe('CreatorTierService', () => {
  it('creates a free subscription lazily and reports the free plan limits', async () => {
    const { fake, service } = build(Date.UTC(2026, 8, 27));

    const view = await service.getSubscription('user_1');

    expect(view.tier).toBe('free');
    expect(view.status).toBe('active');
    expect(view.plan.apiRequestsPerMinute).toBe(60);
    expect(fake.subscriptions).toHaveLength(1);
    // Reading twice must not create a second subscription.
    await service.getSubscription('user_1');
    expect(fake.subscriptions).toHaveLength(1);
  });

  it('grants one trial per creator, then bills the following upgrade', async () => {
    const { fake, creator, service } = build(Date.UTC(2026, 8, 27));

    const trial = await service.upgrade('user_1', { tier: 'pro' });
    expect(trial.paymentRequired).toBe(false);
    expect(trial.invoice).toBeNull();
    expect(trial.subscription.status).toBe('trialing');
    expect(trial.subscription.trialDaysRemaining).toBe(14);

    // The trial is already used, so a second upgrade goes through the provider.
    const billed = await service.upgrade('user_1', { tier: 'pro' });
    expect(billed.paymentRequired).toBe(false);
    expect(billed.invoice?.status).toBe('open');
    expect(billed.invoice?.amountCents).toBe(1900);
    expect(billed.subscription.status).toBe('trialing');

    await service.markInvoicePaid(creator.id, fake.invoices[0].id);
    const view = await service.getSubscription('user_1');
    expect(view.status).toBe('active');
    expect(view.tier).toBe('pro');
    expect(view.trialEndsAt).toBeNull();
  });

  it('activates immediately when the provider collects payment', async () => {
    const { service } = build(Date.UTC(2026, 8, 27), paidProvider);

    const result = await service.upgrade('user_1', { tier: 'enterprise', startTrial: false });

    expect(result.paymentRequired).toBe(false);
    expect(result.subscription.tier).toBe('enterprise');
    expect(result.subscription.status).toBe('active');
    expect(result.subscription.provider).toBe('test-psp');
  });

  it('prorates a mid-period upgrade but charges list price from free', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const { fake, service } = build(nowMs);

    // Free → yearly pro pays the full yearly price, not a prorated month.
    const yearly = await service.upgrade('user_1', {
      tier: 'pro',
      billingPeriod: 'yearly',
      startTrial: false,
    });
    expect(yearly.invoice?.amountCents).toBe(19_000);

    // Move the subscription to a paid monthly pro with 15 days left.
    const subscription = fake.subscriptions[0];
    subscription.tier = 'pro';
    subscription.status = 'active';
    subscription.billingPeriod = 'monthly';
    subscription.currentPeriodEnd = new Date(nowMs + 15 * DAY_MS);
    subscription.trialEndsAt = null;

    const upgrade = await service.upgrade('user_1', { tier: 'enterprise', startTrial: false });

    // 15 of 30 days at the enterprise list price.
    expect(upgrade.invoice?.amountCents).toBe(4_950);
    expect(upgrade.subscription.subscribedTier).toBe('pro');
  });

  it('defers a downgrade until the paid period ends', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const { fake, service } = build(nowMs);

    const subscription = fake.seedSubscription(fake.creators[0].id);
    subscription.tier = 'enterprise';
    subscription.status = 'active';
    subscription.currentPeriodEnd = new Date(nowMs - 1000);

    const deferred = await service.downgrade('user_1', { tier: 'pro' });
    expect(deferred.nextTier).toBe('pro');
    // Still enterprise until the period rolls over.
    expect(deferred.tier).toBe('enterprise');

    const summary = await service.processDueRenewals(new Date(nowMs));
    expect(summary.downgraded).toBe(1);
    expect(fake.subscriptions[0].tier).toBe('pro');
    expect(fake.subscriptions[0].status).toBe('active');
  });

  it('expires a subscription at the end of the period after cancellation', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const { fake, service } = build(nowMs);
    await service.upgrade('user_1', { tier: 'pro' });

    const canceled = await service.cancel('user_1');
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    // Access is already paid for, so the tier survives until the period ends.
    expect(canceled.tier).toBe('pro');

    const subscription = fake.subscriptions[0];
    subscription.status = 'active';
    subscription.currentPeriodEnd = new Date(nowMs - 1000);

    const summary = await service.processDueRenewals(new Date(nowMs));
    expect(summary.expired).toBe(1);
    expect(fake.subscriptions[0].tier).toBe('free');
    expect(fake.subscriptions[0].status).toBe('expired');
    expect(fake.invoices).toHaveLength(0);
  });

  it('invoices a renewal and marks the subscription past due until it is settled', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const { fake, service } = build(nowMs);
    await service.upgrade('user_1', { tier: 'pro', startTrial: false });

    const subscription = fake.subscriptions[0];
    subscription.status = 'active';
    subscription.tier = 'pro';
    subscription.currentPeriodEnd = new Date(nowMs - 1000);
    fake.invoices.length = 0;

    const summary = await service.processDueRenewals(new Date(nowMs));

    expect(summary.invoiced).toBe(1);
    expect(fake.invoices).toHaveLength(1);
    expect(fake.invoices[0].amountCents).toBe(1900);
    expect(fake.subscriptions[0].status).toBe('past_due');
    // A past-due creator keeps the tier while the retry window is open.
    const view = await service.getSubscription('user_1');
    expect(view.tier).toBe('pro');
  });

  it('lists invoices newest first and rejects unknown invoices', async () => {
    const { fake, service } = build(Date.UTC(2026, 8, 27), paidProvider);
    await service.upgrade('user_1', { tier: 'pro', startTrial: false });
    await service.upgrade('user_1', { tier: 'enterprise', startTrial: false });

    const invoices = await service.listInvoices(fake.creators[0].id);
    expect(invoices).toHaveLength(2);
    expect(invoices[0].issuedAt >= invoices[1].issuedAt).toBe(true);

    await expect(service.markInvoicePaid(fake.creators[0].id, 'missing')).rejects.toThrow(/not found/i);
  });

  it('rejects upgrades to a lower tier and to an unknown tier', async () => {
    const { service } = build(Date.UTC(2026, 8, 27), paidProvider);
    await service.upgrade('user_1', { tier: 'enterprise', startTrial: false });

    await expect(service.upgrade('user_1', { tier: 'pro' })).rejects.toThrow(/downgrade endpoint/i);
    await expect(service.upgrade('user_1', { tier: 'platinum' as never })).rejects.toThrow(/unknown creator tier/i);
    await expect(service.upgrade('user_1', { tier: 'free' })).rejects.toThrow(/free tier/i);
    await expect(service.getSubscription('user_missing')).rejects.toThrow(/creator profile/i);
  });
});

describe('CreatorUsageService', () => {
  it('buffers increments and folds them into the month-to-date total once flushed', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const fake = new FakeTierPrisma();
    const usage = new CreatorUsageService(asPrisma(fake), { now: () => nowMs, autoFlush: false });

    usage.increment('creator_1', 'apiRequests', 3);
    usage.increment('creator_1', 'apiRequests');
    usage.increment('creator_1', 'exports');
    // Ignored: a cancelled or negative amount must not move the counters.
    usage.increment('creator_1', 'apiRequests', 0);

    expect(usage.pendingCounters('creator_1').apiRequests).toBe(4);
    expect(await usage.getPeriodUsage('creator_1')).toMatchObject({ apiRequests: 4, exports: 1 });

    expect(await usage.flush()).toBe(1);
    expect(usage.pendingCounters('creator_1').apiRequests).toBe(0);
    expect(fake.usageRows[0]).toMatchObject({ apiRequests: 4, exports: 1 });

    // Buffered and persisted usage are added together, never double counted.
    usage.increment('creator_1', 'apiRequests', 2);
    expect(await usage.getPeriodUsage('creator_1')).toMatchObject({ apiRequests: 6 });

    usage.stop();
  });

  it('summarises usage against the plan and marks an exhausted export quota', async () => {
    const nowMs = Date.UTC(2026, 8, 27);
    const fake = new FakeTierPrisma();
    fake.usageRows.push({
      id: 'usage_1',
      creatorId: 'creator_1',
      period: usagePeriodKey(new Date(nowMs)),
      periodStart: new Date(Date.UTC(2026, 8, 1)),
      apiRequests: 12,
      analyticsQueries: 4,
      exports: 25,
      tipCount: 3,
    });

    const usage = new CreatorUsageService(asPrisma(fake), { now: () => nowMs, autoFlush: false });
    const summary = await usage.summary('creator_1', 'pro');

    expect(summary.period).toBe('2026-09');
    expect(summary.apiRequests).toBe(12);
    expect(summary.limits.monthlyExports).toBe(25);
    expect(summary.remaining.monthlyExports).toBe(0);
    expect(summary.percentUsed.monthlyExports).toBe(100);

    usage.stop();
  });
});
