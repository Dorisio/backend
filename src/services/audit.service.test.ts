import { describe, expect, it, vi } from 'vitest';
import { AuditService, type AuditLogRecord, type AuditLogStore } from './audit.service';

function store(): AuditLogStore & { rows: AuditLogRecord[] } {
  const rows: AuditLogRecord[] = [];
  return {
    rows,
    create: vi.fn(async ({ data }) => ({ ...data, timestamp: data.timestamp ?? new Date() })),
    findMany: vi.fn(async ({ where }) => rows.filter((row) => Object.entries(where).every(([key, value]) => row[key as keyof AuditLogRecord] === value))),
    deleteMany: vi.fn(async () => ({ count: 2 })),
  } as unknown as AuditLogStore & { rows: AuditLogRecord[] };
}

describe('AuditService', () => {
  it('records immutable-shaped entries with changes and correlation id', async () => {
    const db = store();
    const service = new AuditService(db);
    const result = await service.record({ action: 'user.updated', resource: 'user', resourceId: 'u1', requestId: 'req-1', changes: { name: { old: 'A', new: 'B' } } });
    expect(result.id).toEqual(expect.any(String));
    expect(result.changes).toEqual({ name: { old: 'A', new: 'B' } });
    expect(db.create).toHaveBeenCalledOnce();
  });

  it('exports JSON and CSV and enforces retention input', async () => {
    const db = store();
    const service = new AuditService(db);
    await expect(service.export({}, 'json')).resolves.toBe('[]');
    await expect(service.export({}, 'csv')).resolves.toContain('id,userId,action');
    await expect(service.purgeExpired(0)).rejects.toThrow('positive integer');
  });
});
