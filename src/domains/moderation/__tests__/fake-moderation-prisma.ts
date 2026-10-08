/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering the models the
 * moderation service touches. Supports the subset of `where` the service uses:
 * equality, `in`, and scalar comparisons plus `orderBy` on one or many fields.
 *
 * `report.create` also enforces the partial unique index the SQL migration adds
 * for open reports, so the concurrency path is exercised instead of assumed.
 */
import type { PrismaClient } from '@prisma/client';

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();

  if (condition && typeof condition === 'object') {
    const filter = condition as Record<string, unknown>;

    if ('equals' in filter && !matchesValue(value, filter.equals)) return false;
    if ('in' in filter && !(filter.in as unknown[]).some((entry) => matchesValue(value, entry))) {
      return false;
    }
    if ('not' in filter) {
      if (filter.not === null) {
        if (value === null || value === undefined) return false;
      } else if (matchesValue(value, filter.not)) {
        return false;
      }
    }
    if ('lt' in filter && compare(value, filter.lt) >= 0) return false;
    if ('lte' in filter && compare(value, filter.lte) > 0) return false;
    if ('gt' in filter && compare(value, filter.gt) <= 0) return false;
    if ('gte' in filter && compare(value, filter.gte) < 0) return false;
    return true;
  }

  return value === condition;
}

function matchesWhere(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      const parts = Array.isArray(condition) ? condition : [condition];
      return parts.every((part) => matchesWhere(row, part));
    }
    if (key === 'OR') {
      const parts = Array.isArray(condition) ? condition : [condition];
      return parts.some((part) => matchesWhere(row, part));
    }
    return matchesValue(row[key], condition);
  });
}

function applyOrder(rows: Record<string, any>[], orderBy: any): Record<string, any>[] {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  if (orders.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const order of orders) {
      for (const [field, direction] of Object.entries(order as Record<string, string>)) {
        const cmp = compare(a[field], b[field]);
        if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

const OPEN_STATUSES = ['reported', 'investigating'];

export class FakeModerationPrisma {
  users: any[] = [];
  creators: any[] = [];
  tips: any[] = [];
  reports: any[] = [];
  appeals: any[] = [];
  actions: any[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedUser(overrides: Record<string, any> = {}): any {
    const user = {
      id: overrides.id ?? this.nextId('user'),
      email: overrides.email ?? 'user@example.com',
      role: overrides.role ?? 'fan',
      name: 'Test User',
      ...overrides,
    };
    this.users.push(user);
    return user;
  }

  seedTip(overrides: Record<string, any> = {}): any {
    const tip = {
      id: overrides.id ?? this.nextId('tip'),
      fromUserId: overrides.fromUserId ?? this.users[0]?.id,
      creatorId: overrides.creatorId ?? 'creator_1',
      amount: 5,
      message: 'thanks',
      status: 'confirmed',
      moderationState: 'visible',
      ...overrides,
    };
    this.tips.push(tip);
    return tip;
  }

  seedCreator(overrides: Record<string, any> = {}): any {
    const creator = {
      id: overrides.id ?? this.nextId('creator'),
      userId: overrides.userId ?? this.users[0]?.id,
      username: 'stellar-dev',
      ...overrides,
    };
    this.creators.push(creator);
    return creator;
  }

  private project(row: any, select: any): any {
    if (!row) return null;
    if (!select) return row;
    const out: any = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  }

  user = {
    findUnique: async ({ where, select }: any) => {
      const row =
        this.users.find((candidate) =>
          where.id !== undefined ? candidate.id === where.id : candidate.email === where.email
        ) ?? null;
      return this.project(row, select);
    },
  };

  creator = {
    findUnique: async ({ where, select }: any) => {
      const row = this.creators.find((candidate) => candidate.id === where.id) ?? null;
      return this.project(row, select);
    },
  };

  tip = {
    findUnique: async ({ where, select }: any) => {
      const row = this.tips.find((candidate) => candidate.id === where.id) ?? null;
      return this.project(row, select);
    },
    update: async ({ where, data }: any) => {
      const row = this.tips.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('Tip not found');
      Object.assign(row, data);
      return row;
    },
  };

  report = {
    create: async ({ data }: any) => {
      // The partial unique index from the migration, reproduced so the service's
      // conflict mapping is covered.
      const duplicate = this.reports.find(
        (row) =>
          row.reporterId === data.reporterId &&
          row.targetType === data.targetType &&
          row.targetId === data.targetId &&
          row.reportType === data.reportType &&
          OPEN_STATUSES.includes(row.status)
      );
      if (duplicate) {
        const error: any = new Error('Unique constraint failed on the fields: (report_open_unique)');
        error.code = 'P2002';
        throw error;
      }

      const row = {
        id: this.nextId('report'),
        status: 'reported',
        decision: 'none',
        priority: 'normal',
        priorityRank: 2,
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        assignedTo: null,
        autoFlagged: false,
        spamScore: 0,
        spamSignals: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.reports.push(row);
      return row;
    },
    findFirst: async ({ where }: any = {}) =>
      this.reports.find((row) => matchesWhere(row, where)) ?? null,
    findUnique: async ({ where }: any) =>
      this.reports.find((row) => row.id === where.id) ?? null,
    findMany: async ({ where, orderBy, take, skip = 0 }: any = {}) => {
      const rows = applyOrder(
        this.reports.filter((row) => matchesWhere(row, where)),
        orderBy
      );
      return take ? rows.slice(skip, skip + take) : rows.slice(skip);
    },
    count: async ({ where }: any = {}) => this.reports.filter((row) => matchesWhere(row, where)).length,
    update: async ({ where, data }: any) => {
      const row = this.reports.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('Report not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  reportAppeal = {
    create: async ({ data }: any) => {
      const row = {
        id: this.nextId('appeal'),
        status: 'pending',
        notes: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.appeals.push(row);
      return row;
    },
    findFirst: async ({ where }: any = {}) =>
      this.appeals.find((row) => matchesWhere(row, where)) ?? null,
    findUnique: async ({ where }: any) =>
      this.appeals.find((row) => row.id === where.id) ?? null,
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = applyOrder(
        this.appeals.filter((row) => matchesWhere(row, where)),
        orderBy
      );
      return take ? rows.slice(0, take) : rows;
    },
    update: async ({ where, data }: any) => {
      const row = this.appeals.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('Appeal not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  moderationAction = {
    create: async ({ data }: any) => {
      const row = {
        id: this.nextId('action'),
        reportId: null,
        reason: null,
        metadata: {},
        createdAt: new Date(),
        ...data,
      };
      this.actions.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take }: any = {}) => {
      const rows = applyOrder(
        this.actions.filter((row) => matchesWhere(row, where)),
        orderBy
      );
      return take ? rows.slice(0, take) : rows;
    },
  };
}

export const asPrisma = (fake: FakeModerationPrisma): PrismaClient =>
  fake as unknown as PrismaClient;
