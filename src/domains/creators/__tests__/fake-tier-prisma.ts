/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering the models the
 * creator tier service and routes touch. Lets the tests drive real subscription
 * state transitions (trial → paid, scheduled downgrade, renewal) without a
 * database, and assert on the rows that were actually written.
 */
import type { PrismaClient } from '@prisma/client';
import * as StellarSdk from '@stellar/stellar-sdk';

export class FakeTierPrisma {
  creators: any[] = [];
  subscriptions: any[] = [];
  invoices: any[] = [];
  usageRows: any[] = [];
  wallets: any[] = [];
  payouts: any[] = [];
  auditLogs: any[] = [];
  tips: any[] = [];
  webhooks: any[] = [];
  webhookEvents: any[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedCreator(
    overrides: Partial<{
      id: string;
      userId: string;
      username: string;
      totalEarnings: number;
      pendingBalance: number;
      followerCount: number;
    }> = {}
  ): any {
    const creator = {
      id: overrides.id ?? this.nextId('creator'),
      userId: overrides.userId ?? 'user_1',
      username: overrides.username ?? 'stellar-fan',
      totalEarnings: overrides.totalEarnings ?? 0,
      pendingBalance: overrides.pendingBalance ?? 500,
      followerCount: overrides.followerCount ?? 0,
      user: {
        id: overrides.userId ?? 'user_1',
        email: 'creator@example.com',
        name: 'Creator One',
        verified: true,
      },
      ...overrides,
    };
    this.creators.push(creator);
    return creator;
  }

  seedWallet(userId: string, overrides: Record<string, any> = {}): any {
    const wallet = {
      id: this.nextId('wallet'),
      userId,
      publicKey: overrides.publicKey ?? StellarSdk.Keypair.random().publicKey(),
      verified: true,
      createdAt: new Date(),
      ...overrides,
    };
    this.wallets.push(wallet);
    return wallet;
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
    update: async ({ where, data }: any) => {
      const creator = this.creators.find((candidate) =>
        where.userId !== undefined ? candidate.userId === where.userId : candidate.id === where.id
      );
      if (!creator) throw new Error('Creator not found');
      if (data.pendingBalance?.decrement !== undefined) {
        creator.pendingBalance -= data.pendingBalance.decrement;
      }
      if (data.pendingBalance?.increment !== undefined) {
        creator.pendingBalance += data.pendingBalance.increment;
      }
      Object.assign(creator, { ...data, pendingBalance: creator.pendingBalance });
      return creator;
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

  wallet = {
    findFirst: async ({ where }: any) => {
      return (
        this.wallets.find((w) => {
          if (where.userId && w.userId !== where.userId) return false;
          if (where.verified !== undefined && w.verified !== where.verified) return false;
          return true;
        }) ?? null
      );
    },
  };

  payout = {
    create: async ({ data }: any) => {
      const payout = {
        id: this.nextId('payout'),
        createdAt: new Date(),
        updatedAt: new Date(),
        retryCount: 0,
        status: 'pending',
        ...data,
      };
      this.payouts.push(payout);
      return payout;
    },
    findUnique: async ({ where }: any) => {
      const p = this.payouts.find((item) => item.id === where.id);
      if (!p) return null;
      const creator = this.creators.find((c) => c.id === p.creatorId);
      return { ...p, creator };
    },
    update: async ({ where, data }: any) => {
      const p = this.payouts.find((item) => item.id === where.id);
      if (!p) throw new Error('Payout not found');
      Object.assign(p, data, { updatedAt: new Date() });
      return p;
    },
    findMany: async ({ where = {}, take }: any = {}) => {
      const rows = this.payouts.filter((p) =>
        where.creatorId ? p.creatorId === where.creatorId : true
      );
      return take ? rows.slice(0, take) : rows;
    },
  };

  auditLog = {
    create: async ({ data }: any) => {
      const row = {
        id: this.nextId('audit'),
        timestamp: new Date(),
        ...data,
      };
      this.auditLogs.push(row);
      return row;
    },
    findMany: async ({ where = {}, take }: any = {}) => {
      const rows = this.auditLogs.filter((a) => {
        if (where.resource && a.resource !== where.resource) return false;
        if (where.resourceId && a.resourceId !== where.resourceId) return false;
        if (where.userId && a.userId !== where.userId) return false;
        if (where.action && a.action !== where.action) return false;
        return true;
      });
      return take ? rows.slice(0, take) : rows;
    },
    deleteMany: async () => ({ count: 0 }),
  };

  tip = {
    findMany: async ({ where = {}, distinct }: any = {}) => {
      let rows = this.tips.filter((t) => {
        if (where.creatorId && t.creatorId !== where.creatorId) return false;
        if (where.status && t.status !== where.status) return false;
        return true;
      });
      if (distinct && distinct.includes('fromUserId')) {
        const seen = new Set();
        rows = rows.filter((t) => {
          if (seen.has(t.fromUserId)) return false;
          seen.add(t.fromUserId);
          return true;
        });
      }
      return rows;
    },
    count: async ({ where = {} }: any = {}) => {
      return this.tips.filter((t) =>
        where.creatorId ? t.creatorId === where.creatorId : true
      ).length;
    },
    aggregate: async ({ where = {} }: any = {}) => {
      const rows = this.tips.filter((t) =>
        where.creatorId ? t.creatorId === where.creatorId : true
      );
      const sum = rows.reduce((acc, t) => acc + (t.amount || 0), 0);
      return {
        _count: rows.length,
        _sum: { amount: sum },
      };
    },
  };

  webhook = {
    findMany: async () => [],
  };

  webhookEvent = {
    create: async ({ data }: any) => data,
  };
}

export const asPrisma = (fake: FakeTierPrisma): PrismaClient => fake as unknown as PrismaClient;
