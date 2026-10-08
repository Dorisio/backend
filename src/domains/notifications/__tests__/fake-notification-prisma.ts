/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering the models the
 * notification centre touches. Supports the subset of `where` the service uses:
 * equality, null checks, `contains`/`mode: insensitive`, `gte`/`lte`/`lt`, `in`,
 * `not: null`, and `AND`/`OR` composition.
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
    // Prisma combines several operators on one field with AND semantics
    // (`{ not: null, lte: now }`), so every present operator must hold.
    const filter = condition as Record<string, unknown>;

    if ('equals' in filter && !matchesValue(value, filter.equals)) return false;
    if ('not' in filter) {
      if (filter.not === null) {
        if (value === null || value === undefined) return false;
      } else if (matchesValue(value, filter.not)) {
        return false;
      }
    }
    if ('in' in filter && !(filter.in as unknown[]).some((entry) => matchesValue(value, entry))) {
      return false;
    }
    if ('lt' in filter && compare(value, filter.lt) >= 0) return false;
    if ('lte' in filter && compare(value, filter.lte) > 0) return false;
    if ('gt' in filter && compare(value, filter.gt) <= 0) return false;
    if ('gte' in filter && compare(value, filter.gte) < 0) return false;
    if ('contains' in filter) {
      const haystack = typeof value === 'string' ? value : '';
      const needle = String(filter.contains);
      const found =
        filter.mode === 'insensitive'
          ? haystack.toLowerCase().includes(needle.toLowerCase())
          : haystack.includes(needle);
      if (!found) return false;
    }
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

export class FakeNotificationPrisma {
  users: any[] = [];
  notifications: any[] = [];
  preferenceRows: any[] = [];
  digestRows: any[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedUser(overrides: Record<string, any> = {}): any {
    const user = {
      id: overrides.id ?? this.nextId('user'),
      email: overrides.email ?? 'user@example.com',
      name: overrides.name ?? 'Stellar Fan',
      role: overrides.role ?? 'fan',
      notificationPreferences: overrides.notificationPreferences ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.push(user);
    return user;
  }

  seedNotification(overrides: Record<string, any> = {}): any {
    const row = {
      id: this.nextId('notification'),
      userId: overrides.userId ?? this.users[0]?.id,
      type: 'tip.received',
      channel: 'in_app',
      status: 'sent',
      title: 'New tip received',
      body: 'Someone tipped you.',
      data: {},
      readAt: null,
      sentAt: new Date(),
      failedAt: null,
      failureReason: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    this.notifications.push(row);
    return row;
  }

  private project(row: any, select: any): any {
    if (!row) return null;
    const out: any = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  }

  user = {
    findUnique: async ({ where, select }: any) => {
      const row = this.users.find((candidate) =>
        where.id !== undefined ? candidate.id === where.id : candidate.email === where.email
      );
      if (!row) return null;
      return select ? this.project(row, select) : row;
    },
    update: async ({ where, data }: any) => {
      const row = this.users.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('User not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  notification = {
    create: async ({ data }: any) => {
      const row = {
        id: this.nextId('notification'),
        readAt: null,
        sentAt: null,
        failedAt: null,
        failureReason: null,
        expiresAt: null,
        status: 'queued',
        data: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.notifications.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take, skip = 0 }: any = {}) => {
      const rows = applyOrder(
        this.notifications.filter((row) => matchesWhere(row, where)),
        orderBy
      );
      return take ? rows.slice(skip, skip + take) : rows.slice(skip);
    },
    findFirst: async ({ where }: any) => this.notifications.find((row) => matchesWhere(row, where)) ?? null,
    count: async ({ where }: any = {}) => this.notifications.filter((row) => matchesWhere(row, where)).length,
    update: async ({ where, data }: any) => {
      const row = this.notifications.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('Notification not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.notifications.filter((row) => matchesWhere(row, where));
      rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: any = {}) => {
      const keep = this.notifications.filter((row) => !matchesWhere(row, where));
      const count = this.notifications.length - keep.length;
      this.notifications = keep;
      return { count };
    },
  };

  notificationPreference = {
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_eventType_channel;
      const existing = this.preferenceRows.find(
        (row) =>
          row.userId === key.userId && row.eventType === key.eventType && row.channel === key.channel
      );
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const row = { id: this.nextId('pref'), enabled: true, ...create };
      this.preferenceRows.push(row);
      return row;
    },
    findMany: async ({ where }: any = {}) =>
      this.preferenceRows.filter((row) => matchesWhere(row, where)),
    deleteMany: async ({ where }: any = {}) => {
      const keep = this.preferenceRows.filter((row) => !matchesWhere(row, where));
      const count = this.preferenceRows.length - keep.length;
      this.preferenceRows = keep;
      return { count };
    },
  };

  notificationDigestSetting = {
    findUnique: async ({ where }: any) =>
      this.digestRows.find((row) => row.userId === where.userId) ?? null,
    findMany: async ({ where, take }: any = {}) => {
      const rows = this.digestRows.filter((row) => matchesWhere(row, where));
      return take ? rows.slice(0, take) : rows;
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = this.digestRows.find((row) => row.userId === where.userId);
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const row = {
        id: this.nextId('digest'),
        frequency: 'off',
        channel: 'email',
        hourUtc: 8,
        lastSentAt: null,
        ...create,
      };
      this.digestRows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = this.digestRows.find((candidate) => candidate.userId === where.userId);
      if (!row) throw new Error('Digest setting not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };
}

export const asPrisma = (fake: FakeNotificationPrisma): PrismaClient =>
  fake as unknown as PrismaClient;
