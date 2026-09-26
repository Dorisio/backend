import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Tip concurrency guards (Issue #48)', () => {
  const schema = readFileSync(resolve(__dirname, '../schema.prisma'), 'utf8');
  const migration = readFileSync(
    resolve(__dirname, '../migrations/20260926120000_tip_concurrency_guards/migration.sql'),
    'utf8'
  );

  it('adds a version column for optimistic locking', () => {
    expect(schema).toMatch(/version\s+Int\s+@default\(0\)/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "version"/);
  });

  it('adds a unique idempotency key for payment submissions', () => {
    expect(schema).toMatch(/idempotencyKey\s+String\?\s+@unique/);
    expect(migration).toContain('"Tip_idempotencyKey_key"');
  });

  it('pins the status column to the known lifecycle values', () => {
    expect(migration).toContain('"Tip_status_check"');
    for (const status of ['pending', 'completed', 'failed', 'cancelled']) {
      expect(migration).toContain(`'${status}'`);
    }
  });

  it('rejects invalid status transitions at the database level', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION tip_enforce_status_transition');
    expect(migration).toContain('CREATE TRIGGER "tip_status_transition_guard"');
  });
});
