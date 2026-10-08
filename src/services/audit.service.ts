import { randomUUID } from 'node:crypto';

export type AuditChanges = Record<string, { old: unknown; new: unknown }>;

export interface AuditEntry {
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  changes?: AuditChanges;
  timestamp?: Date;
  ipAddress?: string;
  requestId?: string;
}

export interface AuditLogRecord extends AuditEntry {
  id: string;
  changes: AuditChanges;
  timestamp: Date;
}

export interface AuditLogStore {
  create(args: { data: AuditEntry & { id: string; changes: AuditChanges } }): Promise<AuditLogRecord>;
  findMany(args: { where: Record<string, unknown>; orderBy: { timestamp: 'asc' | 'desc' }; take?: number }): Promise<AuditLogRecord[]>;
  deleteMany(args: { where: { timestamp: { lt: Date } } }): Promise<{ count: number }>;
}

export interface AuditQuery {
  userId?: string;
  resource?: string;
  resourceId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Append-only audit operations used by routes, workers, and mutation services. */
export class AuditService {
  constructor(private readonly store: AuditLogStore) {}

  async record(entry: AuditEntry): Promise<AuditLogRecord> {
    return this.store.create({
      data: {
        ...entry,
        id: randomUUID(),
        changes: entry.changes ?? {},
        timestamp: entry.timestamp ?? new Date(),
      },
    });
  }

  async query(query: AuditQuery = {}): Promise<AuditLogRecord[]> {
    const where: Record<string, unknown> = {};
    for (const key of ['userId', 'resource', 'resourceId', 'action'] as const) {
      if (query[key] !== undefined) where[key] = query[key];
    }
    if (query.from || query.to) {
      where.timestamp = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) };
    }
    return this.store.findMany({ where, orderBy: { timestamp: 'desc' }, take: Math.min(query.limit ?? 100, 1_000) });
  }

  async export(query: AuditQuery, format: 'json' | 'csv'): Promise<string> {
    const rows = await this.query(query);
    if (format === 'json') return JSON.stringify(rows);
    const headers = ['id', 'userId', 'action', 'resource', 'resourceId', 'changes', 'timestamp', 'ipAddress', 'requestId'];
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    return [headers.join(','), ...rows.map((row) => headers.map((header) => quote(row[header as keyof AuditLogRecord])).join(','))].join('\n');
  }

  async purgeExpired(retentionDays = 365): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000);
    return (await this.store.deleteMany({ where: { timestamp: { lt: cutoff } } })).count;
  }
}
