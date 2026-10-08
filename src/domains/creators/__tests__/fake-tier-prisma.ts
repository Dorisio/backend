/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering the models the
 * creator tier service and routes touch. Lets the tests drive real subscription
 * state transitions (trial → paid, scheduled downgrade, renewal) without a
 * database, and assert on the rows that were actually written.
 */
import type { PrismaClient } from '@prisma/client';

export class FakeTierPrisma {
  creators: any[] = [];
  subscriptions: any[] = [];
  invoices: any[] = [];
  usageRows: any[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedCreator(overrides: Partial<{ id: string; userId: string; username: string }> = {}): any {
    const creator = {
      id: overrides.id ?? this.nextId('creator'),
      userId: overrides.userId ?? 'user_1',
      username: overrides.username ?? 'stellar-fan',
    };
    this.creators.push(creator);
    return creator;
  }

  seedSubscription(creatorId: string, overrides: Record<string, any> = {}): any {
    const now = new Date();
    const subscription = {
      id: this.nextId('sub'),
      creatorId,
      tier: 'free',
      status: 'active',
      billingPeriod: 'monthly',
      trialEndsAt: null,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      nextTier: null,
      provider: 'internal',
      providerCustomerId: null,
      providerSubscriptionId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.subscriptions.push(subscription);
    return subscription;
  }

  private project(row: any, select: any): any {
    if (!row) return null;
    const out: any = {};
    for (const key of Object.keys(select)) {
      out[key] = row[key];
    }
    return out;
  }

  creator = {
    findUnique: async ({ where, select }: any) => {
      const creator = this.creators.find((candidate) =>
        where.userId !== undefined ? candidate.userId === where.userId : candidate.id === where.id
      );
      if (!creator) return null;

      if (!select) return { ...creator, subscription: this.creatorSubscription.sync(creator.id) };

      const out: any = {};
      for (const key of Object.keys(select)) {
        if (key === 'subscription') {
          const row = this.subscriptions.find((s) => s.creatorId === creator.id) ?? null;
          out.subscription = select.subscription?.select
            ? this.project(row, select.subscription.select)
            : row;
        } else {
          out[key] = creator[key];
        }
      }
      return out;
    },
  };

  creatorSubscription = {
    sync: (creatorId: string) => this.subscriptions.find((s) => s.creatorId === creatorId) ?? null,
    findUnique: async ({ where }: any) => {
      return (
        this.subscriptions.find((s) =>
          where.creatorId !== undefined ? s.creatorId === where.creatorId : s.id === where.id
        ) ?? null
      );
    },
    findMany: async ({ where = {}, take }: any = {}) => {
      const rows = this.subscriptions.filter((s) => {
        if (where.status?.in && !where.status.in.includes(s.status)) return false;
        if (where.currentPeriodEnd?.lte && s.currentPeriodEnd > where.currentPeriodEnd.lte) return false;
        return true;
      });
      return take ? rows.slice(0, take) : rows;
    },
    create: async ({ data }: any) => {
      const now = new Date();
      const subscription = {
        id: this.nextId('sub'),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        nextTier: null,
        trialEndsAt: null,
        providerCustomerId: null,
        providerSubscriptionId: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.subscriptions.push(subscription);
      return subscription;
    },
    update: async ({ where, data }: any) => {
      const subscription = this.subscriptions.find((s) => s.id === where.id);
      if (!subscription) throw new Error('Subscription not found');
      Object.assign(subscription, data, { updatedAt: new Date() });
      return subscription;
    },
  };

  creatorInvoice = {
    create: async ({ data }: any) => {
      const invoice = {
        ...data,
        id: this.nextId('inv'),
        currency: data.currency ?? 'usd',
        issuedAt: data.issuedAt ?? new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.invoices.push(invoice);
      return invoice;
    },
    findUnique: async ({ where }: any) => this.invoices.find((i) => i.id === where.id) ?? null,
    findFirst: async ({ where = {} }: any = {}) =>
      this.invoices.find((i) => (where.creatorId ? i.creatorId === where.creatorId : true) && (where.id ? i.id === where.id : true)) ??
      null,
    findMany: async ({ where = {}, take = 20 }: any = {}) =>
      this.invoices
        .filter((i) => (where.creatorId ? i.creatorId === where.creatorId : true))
        .slice(0, take),
    count: async ({ where = {} }: any = {}) =>
      this.invoices.filter(
        (i) =>
          (where.creatorId ? i.creatorId === where.creatorId : true) &&
          (where.issuedAt?.gte ? i.issuedAt >= where.issuedAt.gte : true)
      ).length,
    update: async ({ where, data }: any) => {
      const invoice = this.invoices.find((i) => i.id === where.id);
      if (!invoice) throw new Error('Invoice not found');
      Object.assign(invoice, data, { updatedAt: new Date() });
      return invoice;
    },
  };

  creatorUsage = {
    findUnique: async ({ where }: any) =>
      this.usageRows.find(
        (row) => row.creatorId === where.creatorId_period.creatorId && row.period === where.creatorId_period.period
      ) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = this.usageRows.find(
        (row) =>
          row.creatorId === where.creatorId_period.creatorId && row.period === where.creatorId_period.period
      );
      if (existing) {
        for (const [metric, change] of Object.entries(update ?? {})) {
          const delta = (change as { increment: number }).increment;
          existing[metric] = (existing[metric] ?? 0) + delta;
        }
        existing.updatedAt = new Date();
        return existing;
      }
      const row = { id: this.nextId('usage'), createdAt: new Date(), updatedAt: new Date(), ...create };
      this.usageRows.push(row);
      return row;
    },
  };
}

export const asPrisma = (fake: FakeTierPrisma): PrismaClient => fake as unknown as PrismaClient;
