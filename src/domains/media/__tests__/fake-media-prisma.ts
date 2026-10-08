/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal in-memory stand-in for the Prisma client, covering only the models the
 * media service touches (`tipMedia`, `mediaQuota`, `tip`). Supports the subset of
 * `where` the service uses: equality, `in`, `not`, `lt`, and `_sum` aggregates.
 */
import type { PrismaClient } from '@prisma/client';

function matchesValue(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();

  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    const filter = condition as Record<string, unknown>;
    if ('in' in filter) return (filter.in as unknown[]).some((entry) => matchesValue(value, entry));
    if ('not' in filter) {
      if (filter.not === null) return value !== null && value !== undefined;
      return !matchesValue(value, filter.not);
    }
    if ('lt' in filter) {
      const left = value instanceof Date ? value.getTime() : (value as any);
      const right = filter.lt instanceof Date ? filter.lt.getTime() : (filter.lt as any);
      return left < right;
    }
    if ('equals' in filter) return matchesValue(value, filter.equals);
    return true;
  }

  return value === condition;
}

function matchesWhere(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => matchesValue(row[key], condition));
}

function applySelect(row: any, select: any): any {
  if (!row) return null;
  if (!select) return { ...row };
  const out: any = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

function applyOrder(rows: any[], orderBy: any): any[] {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  if (orders.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      for (const [field, direction] of Object.entries(order as Record<string, string>)) {
        const left = a[field] instanceof Date ? a[field].getTime() : a[field];
        const right = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (left === right) continue;
        const cmp = left > right ? 1 : -1;
        return direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

export class FakeMediaPrisma {
  tipMedia: any[] = [];
  mediaQuota: any[] = [];
  tips: any[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  seedMedia(overrides: Record<string, any> = {}): any {
    const id = overrides.id ?? this.nextId('media');
    const row = {
      id,
      userId: overrides.userId ?? 'user_1',
      tipId: overrides.tipId ?? null,
      kind: overrides.kind ?? 'image',
      status: overrides.status ?? 'ready',
      mimeType: overrides.mimeType ?? 'image/png',
      fileName: overrides.fileName ?? 'photo.png',
      storageKey: overrides.storageKey ?? `media/user_1/${id}/original.png`,
      sizeBytes: overrides.sizeBytes ?? 1024,
      width: overrides.width ?? null,
      height: overrides.height ?? null,
      durationSeconds: overrides.durationSeconds ?? null,
      derivatives: overrides.derivatives ?? [],
      processingStatus: overrides.processingStatus ?? 'pending',
      processingError: overrides.processingError ?? null,
      scanner: overrides.scanner ?? 'eicar',
      scanSignature: overrides.scanSignature ?? null,
      scanCompletedAt: overrides.scanCompletedAt ?? null,
      uploadedAt: overrides.uploadedAt ?? null,
      attachedAt: overrides.attachedAt ?? null,
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
      ...overrides,
    };
    this.tipMedia.push(row);
    return row;
  }

  seedQuota(overrides: Record<string, any> = {}): any {
    const row = {
      id: overrides.id ?? this.nextId('quota'),
      userId: overrides.userId ?? 'user_1',
      usedBytes: overrides.usedBytes ?? 0,
      fileCount: overrides.fileCount ?? 0,
      limitBytes: overrides.limitBytes ?? 256 * 1024 * 1024,
      ...overrides,
    };
    this.mediaQuota.push(row);
    return row;
  }

  seedTip(overrides: Record<string, any> = {}): any {
    const row = {
      id: overrides.id ?? this.nextId('tip'),
      moderationState: overrides.moderationState ?? 'visible',
      ...overrides,
    };
    this.tips.push(row);
    return row;
  }

  private tipMediaModel = {
    create: async ({ data }: any) => {
      const row = this.seedMedia({ ...data });
      // Prisma returns generated defaults; the fake already applies them.
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const row = this.tipMedia.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('Media not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.tipMedia.filter((row) => matchesWhere(row, where));
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
      return { count: rows.length };
    },
    delete: async ({ where }: any) => {
      const index = this.tipMedia.findIndex((row) => row.id === where.id);
      if (index === -1) throw new Error('Media not found');
      return this.tipMedia.splice(index, 1)[0];
    },
    findUnique: async ({ where, select }: any) => {
      const row = this.tipMedia.find((candidate) => candidate.id === where.id) ?? null;
      return applySelect(row, select);
    },
    findMany: async ({ where, orderBy, take, skip = 0 }: any = {}) => {
      const rows = applyOrder(
        this.tipMedia.filter((row) => matchesWhere(row, where)),
        orderBy
      );
      return (take ? rows.slice(skip, skip + take) : rows.slice(skip)).map((row) => ({ ...row }));
    },
    count: async ({ where }: any = {}) => this.tipMedia.filter((row) => matchesWhere(row, where)).length,
    aggregate: async ({ where, _sum }: any = {}) => {
      const rows = this.tipMedia.filter((row) => matchesWhere(row, where));
      const result: any = { _sum: {} };
      for (const field of Object.keys(_sum ?? {})) {
        result._sum[field] = rows.reduce((total, row) => total + (row[field] ?? 0), 0);
      }
      return result;
    },
  };

  private mediaQuotaModel = {
    findUnique: async ({ where }: any) =>
      this.mediaQuota.find((row) => row.userId === where.userId) ?? null,
    upsert: async ({ where, create }: any) => {
      const existing = this.mediaQuota.find((row) => row.userId === where.userId);
      if (existing) return existing;
      const row = { id: this.nextId('quota'), ...create };
      this.mediaQuota.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = this.mediaQuota.find((candidate) => candidate.userId === where.userId);
      if (!row) throw new Error('Quota not found');
      Object.assign(row, data);
      return row;
    },
  };

  private tipModel = {
    findUnique: async ({ where, select }: any) => {
      const row = this.tips.find((candidate) => candidate.id === where.id) ?? null;
      return applySelect(row, select);
    },
  };

  // Prisma exposes delegates as properties; the service reads them off the client.
  get client(): PrismaClient {
    const self = this;
    return {
      tipMedia: self.tipMediaModel,
      mediaQuota: self.mediaQuotaModel,
      tip: self.tipModel,
    } as unknown as PrismaClient;
  }
}

export const asPrisma = (fake: FakeMediaPrisma): PrismaClient => fake.client;
