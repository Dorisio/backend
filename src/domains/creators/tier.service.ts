/**
 * Creator subscription tiers: billing state, usage and invoices (issue #69).
 *
 * Responsibilities split deliberately:
 *   - `CreatorTierService` owns the subscription state machine (trial, upgrade,
 *     downgrade, cancel, renewal) and issues invoices.
 *   - `CreatorUsageService` counts what a creator consumes. It buffers counts in
 *     memory and writes them in batches, so an API request never waits on a
 *     database write.
 *
 * Money is expressed in integer cents throughout; the API converts to a
 * display currency, never the other way round.
 */

import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_CREATOR_TIER,
  buildUpgradeOptions,
  getCreatorTierPlan,
  isCreatorTier,
  listCreatorTierPlans,
  isTierAtLeast,
  nextCreatorTier,
  prorateTierChangeCents,
  remainingQuota,
  resolveEffectiveTier,
  trialDaysRemaining,
  type CreatorSubscriptionStatus,
  type CreatorTier,
  type CreatorTierPlan,
  type TierUpgradeOption,
} from '../../config/creator-tiers';
import type { CreatorUsageMetric } from '../../middleware/creator-tier';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors';

export type CreatorBillingPeriod = 'monthly' | 'yearly';
export type CreatorInvoiceStatus = 'open' | 'paid' | 'void' | 'uncollectible';

export const BILLING_CURRENCY = 'usd';

export interface TierBillingChargeInput {
  creatorId: string;
  tier: CreatorTier;
  billingPeriod: CreatorBillingPeriod;
  amountCents: number;
  invoiceNumber: string;
  providerCustomerId?: string | null;
}

export interface TierBillingChargeResult {
  status: Extract<CreatorInvoiceStatus, 'paid' | 'open' | 'uncollectible'>;
  providerCustomerId?: string | null;
  providerInvoiceId?: string | null;
  providerSubscriptionId?: string | null;
  failureReason?: string;
}

/**
 * Payment collection. The default provider issues an invoice and leaves it open
 * for the platform's existing payment flow to settle; a real PSP adapter (Stripe,
 * which the payments domain already integrates with) implements the same one
 * method and is swapped in by passing it to the service.
 */
export interface TierBillingProvider {
  readonly name: string;
  charge(input: TierBillingChargeInput): Promise<TierBillingChargeResult>;
}

export const invoiceOnlyBillingProvider: TierBillingProvider = {
  name: 'internal',
  async charge() {
    return { status: 'open' };
  },
};

export interface CreatorSubscriptionView {
  tier: CreatorTier;
  subscribedTier: CreatorTier;
  status: CreatorSubscriptionStatus;
  billingPeriod: CreatorBillingPeriod;
  plan: CreatorTierPlan;
  trialEndsAt: string | null;
  trialDaysRemaining: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  nextTier: CreatorTier | null;
  provider: string;
  priceCents: number;
  upgradeOptions: TierUpgradeOption[];
}

export interface CreatorUsageSummary {
  period: string;
  apiRequests: number;
  analyticsQueries: number;
  exports: number;
  tipCount: number;
  limits: {
    apiRequestsPerMinute: number;
    apiRequestsPerDay: number;
    analyticsHistoryDays: number;
    maxTeamMembers: number;
    monthlyExports: number;
  };
  remaining: {
    monthlyExports: number;
  };
  percentUsed: {
    monthlyExports: number;
  };
}

export interface CreatorInvoiceView {
  id: string;
  number: string;
  status: CreatorInvoiceStatus;
  tier: CreatorTier;
  billingPeriod: CreatorBillingPeriod;
  amountCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
}

export function usagePeriodKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usagePeriodStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface SubscriptionRow {
  id: string;
  creatorId: string;
  tier: string;
  status: string;
  billingPeriod: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  nextTier: string | null;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
}

export interface CreatorTierServiceOptions {
  now?: () => number;
  billing?: TierBillingProvider;
  /** Invalidated after every write so tier changes apply immediately. */
  onTierChanged?: (userId: string) => void;
}

export class CreatorTierService {
  private readonly now: () => number;
  private readonly billing: TierBillingProvider;
  private readonly onTierChanged?: (userId: string) => void;

  constructor(
    private readonly prisma: PrismaClient,
    options: CreatorTierServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.billing = options.billing ?? invoiceOnlyBillingProvider;
    this.onTierChanged = options.onTierChanged;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Subscription for the authenticated creator, created on first read. */
  async getSubscription(userId: string): Promise<CreatorSubscriptionView> {
    const creator = await this.requireCreator(userId);
    const row = await this.ensureSubscription(creator.id);
    return this.toView(row);
  }

  getPlans(): CreatorTierPlan[] {
    return listCreatorTierPlans();
  }

  async listInvoices(creatorId: string, limit = 20): Promise<CreatorInvoiceView[]> {
    const invoices = await this.prisma.creatorInvoice.findMany({
      where: { creatorId },
      orderBy: { issuedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });

    return invoices.map((invoice) => this.toInvoiceView(invoice));
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Moves a creator to a higher tier. A first upgrade may start a free trial
   * (no invoice); otherwise the provider collects payment and the tier only
   * changes once the invoice is settled.
   */
  async upgrade(
    userId: string,
    input: { tier: CreatorTier; billingPeriod?: CreatorBillingPeriod; startTrial?: boolean }
  ): Promise<{ subscription: CreatorSubscriptionView; invoice: CreatorInvoiceView | null; paymentRequired: boolean }> {
    if (!isCreatorTier(input.tier)) {
      throw new BadRequestError(`Unknown creator tier: ${String(input.tier)}`);
    }
    if (input.tier === DEFAULT_CREATOR_TIER) {
      throw new BadRequestError('Use the downgrade endpoint to move to the free tier');
    }

    const creator = await this.requireCreator(userId);
    const current = await this.ensureSubscription(creator.id);
    const currentTier = this.effectiveTier(current);

    if (!isTierAtLeast(input.tier, currentTier)) {
      throw new ConflictError('Use the downgrade endpoint to move to a lower tier', {
        currentTier,
        requestedTier: input.tier,
      });
    }

    if (current.status === 'active' && current.tier === input.tier) {
      throw new ConflictError(`Already subscribed to the ${input.tier} tier`, {
        currentTier,
        requestedTier: input.tier,
      });
    }

    const plan = getCreatorTierPlan(input.tier);
    const billingPeriod: CreatorBillingPeriod = input.billingPeriod ?? 'monthly';
    const nowMs = this.now();
    const now = new Date(nowMs);

    const wantsTrial =
      (input.startTrial ?? plan.trialDays > 0) &&
      plan.trialDays > 0 &&
      current.trialEndsAt === null &&
      current.tier === DEFAULT_CREATOR_TIER;

    if (wantsTrial) {
      const trialEndsAt = new Date(nowMs + plan.trialDays * 24 * 60 * 60 * 1000);
      const updated = await this.prisma.creatorSubscription.update({
        where: { id: current.id },
        data: {
          tier: input.tier,
          status: 'trialing',
          billingPeriod,
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd: trialEndsAt,
          cancelAtPeriodEnd: false,
          nextTier: null,
        },
      });

      this.onTierChanged?.(userId);
      return { subscription: this.toView(updated), invoice: null, paymentRequired: false };
    }

    const amountCents = this.priceFor(input.tier, billingPeriod, current, nowMs);
    const invoiceNumber = await this.nextInvoiceNumber(creator.id, now);
    const periodEnd = addMonths(now, billingPeriod === 'yearly' ? 12 : 1);

    const charge = await this.billing.charge({
      creatorId: creator.id,
      tier: input.tier,
      billingPeriod,
      amountCents,
      invoiceNumber,
      providerCustomerId: current.providerCustomerId,
    });

    const invoice = await this.prisma.creatorInvoice.create({
      data: {
        creatorId: creator.id,
        subscriptionId: current.id,
        number: invoiceNumber,
        status: charge.status,
        tier: input.tier,
        billingPeriod,
        amountCents,
        currency: BILLING_CURRENCY,
        periodStart: now,
        periodEnd,
        provider: this.billing.name,
        providerInvoiceId: charge.providerInvoiceId ?? null,
        dueAt: charge.status === 'open' ? periodEnd : null,
        paidAt: charge.status === 'paid' ? now : null,
        lineItems: [
          {
            description: `${plan.name} plan (${billingPeriod})`,
            amountCents,
            tier: input.tier,
            periodStart: now.toISOString(),
            periodEnd: periodEnd.toISOString(),
          },
        ],
      },
    });

    if (charge.status !== 'paid') {
      // Nothing to activate until the provider settles the invoice.
      return {
        subscription: this.toView(current),
        invoice: this.toInvoiceView(invoice),
        paymentRequired: true,
      };
    }

    const updated = await this.prisma.creatorSubscription.update({
      where: { id: current.id },
      data: {
        tier: input.tier,
        status: 'active',
        billingPeriod,
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        nextTier: null,
        provider: this.billing.name,
        providerCustomerId: charge.providerCustomerId ?? current.providerCustomerId,
        providerSubscriptionId: charge.providerSubscriptionId ?? current.providerSubscriptionId,
      },
    });

    this.onTierChanged?.(userId);
    return {
      subscription: this.toView(updated),
      invoice: this.toInvoiceView(invoice),
      paymentRequired: false,
    };
  }

  /**
   * Moves a creator to a lower tier. Deferred by default (the paid period is
   * already paid for); `immediate: true` applies it now, for example when a
   * subscription is being wound down by support.
   */
  async downgrade(
    userId: string,
    input: { tier: CreatorTier; immediate?: boolean }
  ): Promise<CreatorSubscriptionView> {
    if (!isCreatorTier(input.tier)) {
      throw new BadRequestError(`Unknown creator tier: ${String(input.tier)}`);
    }

    const creator = await this.requireCreator(userId);
    const current = await this.ensureSubscription(creator.id);
    const currentTier = this.effectiveTier(current);

    if (isTierAtLeast(input.tier, currentTier) && input.tier !== currentTier) {
      throw new ConflictError('Use the upgrade endpoint to move to a higher tier', {
        currentTier,
        requestedTier: input.tier,
      });
    }

    if (input.immediate) {
      const updated = await this.prisma.creatorSubscription.update({
        where: { id: current.id },
        data: {
          tier: input.tier,
          status: input.tier === DEFAULT_CREATOR_TIER ? 'expired' : 'active',
          trialEndsAt: null,
          cancelAtPeriodEnd: false,
          nextTier: null,
        },
      });

      this.onTierChanged?.(userId);
      return this.toView(updated);
    }

    const updated = await this.prisma.creatorSubscription.update({
      where: { id: current.id },
      data: {
        nextTier: input.tier,
        cancelAtPeriodEnd: input.tier === DEFAULT_CREATOR_TIER,
      },
    });

    return this.toView(updated);
  }

  /** Stops the subscription at the end of the paid period. */
  async cancel(userId: string, input: { immediate?: boolean } = {}): Promise<CreatorSubscriptionView> {
    const creator = await this.requireCreator(userId);
    const current = await this.ensureSubscription(creator.id);
    const nowMs = this.now();

    const data = input.immediate
      ? {
          status: 'expired' as const,
          tier: DEFAULT_CREATOR_TIER,
          nextTier: null,
          cancelAtPeriodEnd: false,
        }
      : { cancelAtPeriodEnd: true };

    const updated = await this.prisma.creatorSubscription.update({
      where: { id: current.id },
      data: { ...data, canceledAt: new Date(nowMs) },
    });

    this.onTierChanged?.(userId);
    return this.toView(updated);
  }

  /** Undoes a scheduled cancellation, as long as the period has not ended. */
  async resume(userId: string): Promise<CreatorSubscriptionView> {
    const creator = await this.requireCreator(userId);
    const current = await this.ensureSubscription(creator.id);

    if (current.status === 'expired') {
      throw new ConflictError('This subscription has ended; start a new plan instead');
    }

    const updated = await this.prisma.creatorSubscription.update({
      where: { id: current.id },
      data: { cancelAtPeriodEnd: false, nextTier: null, canceledAt: null },
    });

    this.onTierChanged?.(userId);
    return this.toView(updated);
  }

  /**
   * Settles an open invoice and activates what it paid for. Used by the billing
   * webhook or by support when a payment lands out of band.
   */
  async markInvoicePaid(
    creatorId: string,
    invoiceId: string,
    providerInvoiceId?: string
  ): Promise<{ invoice: CreatorInvoiceView; subscription: CreatorSubscriptionView }> {
    const invoice = await this.prisma.creatorInvoice.findFirst({
      where: { id: invoiceId, creatorId },
    });

    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === 'paid') {
      throw new ConflictError('Invoice is already paid');
    }

    const now = new Date(this.now());
    const updatedInvoice = await this.prisma.creatorInvoice.update({
      where: { id: invoice.id },
      data: {
        status: 'paid',
        paidAt: now,
        providerInvoiceId: providerInvoiceId ?? invoice.providerInvoiceId,
      },
    });

    const subscription = await this.prisma.creatorSubscription.findUnique({
      where: { creatorId },
    });

    if (!subscription) throw new NotFoundError('Subscription');

    const tier = isCreatorTier(invoice.tier) ? (invoice.tier as CreatorTier) : DEFAULT_CREATOR_TIER;
    const updatedSubscription = await this.prisma.creatorSubscription.update({
      where: { id: subscription.id },
      data: {
        tier,
        status: 'active',
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: invoice.periodEnd,
        cancelAtPeriodEnd: false,
        nextTier: null,
      },
    });

    return {
      invoice: this.toInvoiceView(updatedInvoice),
      subscription: this.toView(updatedSubscription),
    };
  }

  /**
   * Rolls every subscription whose period has ended. Run on a schedule:
   *   - an ended trial becomes a paid subscription and renews for a period;
   *   - a scheduled downgrade (or cancellation) takes effect;
   *   - an unchanged subscription renews and is invoiced.
   * `past_due` subscriptions are left alone: recovering them belongs to the
   * payment retry flow, not to the renewal job.
   */
  async processDueRenewals(
    now: Date = new Date(this.now())
  ): Promise<{ processed: number; invoiced: number; downgraded: number; expired: number }> {
    const due = await this.prisma.creatorSubscription.findMany({
      where: {
        currentPeriodEnd: { lte: now },
        status: { in: ['trialing', 'active'] },
      },
      take: 500,
    });

    let invoiced = 0;
    let downgraded = 0;
    let expired = 0;

    for (const subscription of due) {
      const canceling = subscription.cancelAtPeriodEnd;
      const nextTier = isCreatorTier(subscription.nextTier) ? (subscription.nextTier as CreatorTier) : null;

      if (canceling && !nextTier) {
        await this.prisma.creatorSubscription.update({
          where: { id: subscription.id },
          data: { status: 'expired', tier: DEFAULT_CREATOR_TIER, cancelAtPeriodEnd: false },
        });
        expired += 1;
        continue;
      }

      if (nextTier && nextTier !== subscription.tier) {
        const billingPeriod: CreatorBillingPeriod =
          subscription.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
        const periodEnd = addMonths(now, billingPeriod === 'yearly' ? 12 : 1);

        await this.prisma.creatorSubscription.update({
          where: { id: subscription.id },
          data: {
            tier: nextTier,
            status: nextTier === DEFAULT_CREATOR_TIER ? 'expired' : 'active',
            nextTier: null,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        });
        downgraded += 1;
        continue;
      }

      const billingPeriod: CreatorBillingPeriod =
        subscription.billingPeriod === 'yearly' ? 'yearly' : 'monthly';
      const tier = isCreatorTier(subscription.tier) ? (subscription.tier as CreatorTier) : DEFAULT_CREATOR_TIER;
      const periodEnd = addMonths(now, billingPeriod === 'yearly' ? 12 : 1);
      const amountCents = this.priceFor(tier, billingPeriod, subscription as SubscriptionRow, now.getTime());
      const invoiceNumber = await this.nextInvoiceNumber(subscription.creatorId, now);

      const charge = await this.billing.charge({
        creatorId: subscription.creatorId,
        tier,
        billingPeriod,
        amountCents,
        invoiceNumber,
        providerCustomerId: subscription.providerCustomerId,
      });

      await this.prisma.creatorInvoice.create({
        data: {
          creatorId: subscription.creatorId,
          subscriptionId: subscription.id,
          number: invoiceNumber,
          status: charge.status,
          tier,
          billingPeriod,
          amountCents,
          currency: BILLING_CURRENCY,
          periodStart: now,
          periodEnd,
          provider: this.billing.name,
          paidAt: charge.status === 'paid' ? now : null,
          dueAt: charge.status === 'open' ? periodEnd : null,
          lineItems: [
            {
              description: `${getCreatorTierPlan(tier).name} plan renewal (${billingPeriod})`,
              amountCents,
              tier,
            },
          ],
        },
      });

      await this.prisma.creatorSubscription.update({
        where: { id: subscription.id },
        data: {
          status: charge.status === 'paid' ? 'active' : 'past_due',
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });

      invoiced += 1;
    }

    return { processed: due.length, invoiced, downgraded, expired };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireCreator(userId: string): Promise<{ id: string; userId: string }> {
    const creator = await this.prisma.creator.findUnique({
      where: { userId },
      select: { id: true, userId: true },
    });

    if (!creator) throw new NotFoundError('Creator profile');
    return creator;
  }

  /** Creates the default free subscription the first time it is needed. */
  async ensureSubscription(creatorId: string): Promise<SubscriptionRow> {
    const existing = await this.prisma.creatorSubscription.findUnique({ where: { creatorId } });
    if (existing) return existing as SubscriptionRow;

    const now = new Date(this.now());
    const periodEnd = addMonths(now, 1);

    const created = await this.prisma.creatorSubscription.create({
      data: {
        creatorId,
        tier: DEFAULT_CREATOR_TIER,
        status: 'active',
        billingPeriod: 'monthly',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        provider: this.billing.name,
      },
    });

    return created as SubscriptionRow;
  }

  private effectiveTier(row: SubscriptionRow): CreatorTier {
    return resolveEffectiveTier({
      tier: isCreatorTier(row.tier) ? (row.tier as CreatorTier) : DEFAULT_CREATOR_TIER,
      status: row.status as CreatorSubscriptionStatus,
      trialEndsAt: row.trialEndsAt,
      currentPeriodEnd: row.currentPeriodEnd,
    });
  }

  private priceFor(
    tier: CreatorTier,
    billingPeriod: CreatorBillingPeriod,
    current: SubscriptionRow,
    nowMs: number
  ): number {
    const plan = getCreatorTierPlan(tier);
    const listPrice = billingPeriod === 'yearly' ? plan.priceYearlyCents : plan.priceMonthlyCents;

    const currentTier = this.effectiveTier(current);
    // Mid-period upgrades are prorated against what is left of the paid period.
    // A free (or still-trialing) period has no paid days to credit, so it pays
    // list price — otherwise a yearly plan would be billed as one month.
    const hasPaidPeriod = currentTier !== DEFAULT_CREATOR_TIER && current.status === 'active';

    if (hasPaidPeriod && currentTier !== tier && isTierAtLeast(tier, currentTier)) {
      const prorated = prorateTierChangeCents(currentTier, tier, current.currentPeriodEnd, new Date(nowMs));
      if (prorated > 0) return prorated;
    }

    return listPrice;
  }

  private async nextInvoiceNumber(creatorId: string, now: Date): Promise<string> {
    const period = usagePeriodKey(now);
    const issued = await this.prisma.creatorInvoice.count({
      where: { creatorId, issuedAt: { gte: usagePeriodStart(now) } },
    });

    const sequence = String(issued + 1).padStart(3, '0');
    return `INV-${period.replace('-', '')}-${creatorId.slice(-6).toUpperCase()}-${sequence}`;
  }

  private toView(row: SubscriptionRow): CreatorSubscriptionView {
    const subscribedTier = isCreatorTier(row.tier) ? (row.tier as CreatorTier) : DEFAULT_CREATOR_TIER;
    const tier = this.effectiveTier(row);
    const plan = getCreatorTierPlan(subscribedTier);
    const billingPeriod: CreatorBillingPeriod = row.billingPeriod === 'yearly' ? 'yearly' : 'monthly';

    return {
      tier,
      subscribedTier,
      status: row.status as CreatorSubscriptionStatus,
      billingPeriod,
      plan,
      trialEndsAt: toIso(row.trialEndsAt),
      trialDaysRemaining: trialDaysRemaining({
        tier: subscribedTier,
        status: row.status as CreatorSubscriptionStatus,
        trialEndsAt: row.trialEndsAt,
      }),
      currentPeriodStart: toIso(row.currentPeriodStart) ?? new Date(this.now()).toISOString(),
      currentPeriodEnd: toIso(row.currentPeriodEnd) ?? new Date(this.now()).toISOString(),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      nextTier: isCreatorTier(row.nextTier) ? (row.nextTier as CreatorTier) : null,
      provider: row.provider,
      priceCents: billingPeriod === 'yearly' ? plan.priceYearlyCents : plan.priceMonthlyCents,
      upgradeOptions: buildUpgradeOptions(tier, row.currentPeriodEnd, new Date(this.now())),
    };
  }

  private toInvoiceView(invoice: {
    id: string;
    number: string;
    status: string;
    tier: string;
    billingPeriod: string;
    amountCents: number;
    currency: string;
    periodStart: Date;
    periodEnd: Date;
    issuedAt: Date;
    dueAt: Date | null;
    paidAt: Date | null;
  }): CreatorInvoiceView {
    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status as CreatorInvoiceStatus,
      tier: isCreatorTier(invoice.tier) ? (invoice.tier as CreatorTier) : DEFAULT_CREATOR_TIER,
      billingPeriod: invoice.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      periodStart: toIso(invoice.periodStart) ?? '',
      periodEnd: toIso(invoice.periodEnd) ?? '',
      issuedAt: toIso(invoice.issuedAt) ?? '',
      dueAt: toIso(invoice.dueAt),
      paidAt: toIso(invoice.paidAt),
    };
  }
}

interface UsageCounters {
  apiRequests: number;
  analyticsQueries: number;
  exports: number;
  tipCount: number;
}

const ZERO_COUNTERS: UsageCounters = {
  apiRequests: 0,
  analyticsQueries: 0,
  exports: 0,
  tipCount: 0,
};

export interface CreatorUsageServiceOptions {
  now?: () => number;
  /** Buffered usage is written at most this often. */
  flushIntervalMs?: number;
  /** Set to false in tests to flush explicitly. */
  autoFlush?: boolean;
}

/**
 * Counts creator usage and exposes it month-to-date.
 *
 * Counters are buffered per creator, period and metric, then written with a
 * single upsert per creator. A request path therefore costs a Map update, and a
 * busy creator costs one row per month instead of one write per request.
 */
export class CreatorUsageService {
  private readonly pending = new Map<string, { creatorId: string; period: string; counters: UsageCounters }>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    options: CreatorUsageServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());

    if (options.autoFlush !== false) {
      this.timer = setInterval(() => {
        void this.flush();
      }, options.flushIntervalMs ?? 30_000);
      // Never keep the process alive just to flush counters.
      this.timer.unref?.();
    }
  }

  /** Buffered increment — safe to call on the request path. */
  increment(creatorId: string, metric: CreatorUsageMetric, amount = 1): void {
    if (amount <= 0) return;

    const period = usagePeriodKey(new Date(this.now()));
    const key = `${creatorId}:${period}`;
    const entry = this.pending.get(key) ?? { creatorId, period, counters: { ...ZERO_COUNTERS } };

    entry.counters[metric] += amount;
    this.pending.set(key, entry);
  }

  pendingCounters(creatorId: string): UsageCounters {
    const period = usagePeriodKey(new Date(this.now()));
    return this.pending.get(`${creatorId}:${period}`)?.counters ?? { ...ZERO_COUNTERS };
  }

  /** Writes buffered counters. Returns how many rows were touched. */
  async flush(): Promise<number> {
    if (this.pending.size === 0) return 0;

    const batch = Array.from(this.pending.entries());
    this.pending.clear();

    let written = 0;

    for (const [, entry] of batch) {
      const increment: Record<string, { increment: number }> = {};
      for (const [metric, value] of Object.entries(entry.counters)) {
        if (value > 0) increment[metric] = { increment: value };
      }

      if (Object.keys(increment).length === 0) continue;

      await this.prisma.creatorUsage.upsert({
        where: { creatorId_period: { creatorId: entry.creatorId, period: entry.period } },
        create: {
          creatorId: entry.creatorId,
          period: entry.period,
          periodStart: usagePeriodStart(new Date(this.now())),
          ...entry.counters,
        },
        update: increment,
      });

      written += 1;
    }

    return written;
  }

  /** Records a low-volume event and writes it immediately. */
  async record(creatorId: string, metric: CreatorUsageMetric, amount = 1): Promise<void> {
    this.increment(creatorId, metric, amount);
    await this.flush();
  }

  async getPeriodUsage(creatorId: string, period = usagePeriodKey(new Date(this.now()))): Promise<UsageCounters> {
    const row = await this.prisma.creatorUsage.findUnique({
      where: { creatorId_period: { creatorId, period } },
    });

    const buffered = this.pending.get(`${creatorId}:${period}`)?.counters ?? ZERO_COUNTERS;

    return {
      apiRequests: (row?.apiRequests ?? 0) + buffered.apiRequests,
      analyticsQueries: (row?.analyticsQueries ?? 0) + buffered.analyticsQueries,
      exports: (row?.exports ?? 0) + buffered.exports,
      tipCount: (row?.tipCount ?? 0) + buffered.tipCount,
    };
  }

  /** Usage against the plan a creator is paying for. */
  async summary(creatorId: string, tier: CreatorTier): Promise<CreatorUsageSummary> {
    const period = usagePeriodKey(new Date(this.now()));
    const usage = await this.getPeriodUsage(creatorId, period);
    const plan = getCreatorTierPlan(tier);

    return {
      period,
      ...usage,
      limits: {
        apiRequestsPerMinute: plan.apiRequestsPerMinute,
        apiRequestsPerDay: plan.apiRequestsPerDay,
        analyticsHistoryDays: plan.analyticsHistoryDays,
        maxTeamMembers: plan.maxTeamMembers,
        monthlyExports: plan.monthlyExports,
      },
      remaining: {
        monthlyExports: remainingQuota(plan.monthlyExports, usage.exports),
      },
      percentUsed: {
        monthlyExports:
          plan.monthlyExports === 0
            ? 100
            : Math.min(100, Math.round((usage.exports / plan.monthlyExports) * 100)),
      },
    };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export { nextCreatorTier, getCreatorTierPlan };
