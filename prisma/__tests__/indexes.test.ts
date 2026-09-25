import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Prisma indexing strategy (Issue #29)', () => {
  const schema = readFileSync(resolve(__dirname, '../schema.prisma'), 'utf8');

  it('indexes foreign keys and common filters', () => {
    expect(schema).toMatch(/@@index\(\[creatorId/);
    expect(schema).toMatch(/@@index\(\[fromUserId/);
    expect(schema).toMatch(/@@index\(\[webhookId/);
    expect(schema).toMatch(/@@index\(\[status\]/);
    expect(schema).toMatch(/@@index\(\[verified, isPublic\]/);
  });

  it('adds unique transactionHash and composite webhook delivery index', () => {
    expect(schema).toMatch(/transactionHash String\? @unique/);
    expect(schema).toMatch(/@@index\(\[webhookId, status\]/);
    expect(schema).toMatch(/@@index\(\[role\]/);
    expect(schema).toMatch(/@@index\(\[createdAt\]/);
  });
});

describe('Query performance indexes (Issue #12)', () => {
  const schema = readFileSync(resolve(__dirname, '../schema.prisma'), 'utf8');
  const migration = readFileSync(
    resolve(__dirname, '../migrations/20260925120000_query_performance_indexes/migration.sql'),
    'utf8'
  );

  const expectedIndexes = [
    'idx_user_role_createdAt',
    'idx_creator_public_createdAt',
    'idx_creator_public_verified_earnings',
    'idx_creator_totalEarnings',
    'idx_tip_creator_createdAt',
    'idx_tip_fromUser_status_createdAt',
    'idx_tip_status_createdAt',
    'idx_tip_creator_status_fromUser',
    'idx_webhook_creator_createdAt',
    'idx_webhook_creator_active_createdAt',
    'idx_webhookEvent_webhook_createdAt',
    'idx_webhookEvent_status_createdAt',
    'idx_walletFlag_resolved_severity_createdAt',
    'idx_accountFreeze_creator_resolved_createdAt',
    'idx_accountFreeze_resolved_expiresAt',
  ];

  it('declares every new index in the Prisma schema with a stable name', () => {
    for (const index of expectedIndexes) {
      expect(schema).toContain(`map: "${index}"`);
    }
  });

  it('covers the hot filter+sort combinations used by the services', () => {
    // Leading column is the equality filter, trailing columns the ORDER BY, so
    // PostgreSQL can satisfy both from the index without a sort node.
    expect(schema).toMatch(/@@index\(\[creatorId, createdAt\(sort: Desc\), id\(sort: Desc\)\]/);
    expect(schema).toMatch(/@@index\(\[creatorId, status, fromUserId\]/);
    expect(schema).toMatch(/@@index\(\[fromUserId, status, createdAt\(sort: Desc\)\]/);
    expect(schema).toMatch(/@@index\(\[isPublic, createdAt\(sort: Desc\), id\(sort: Desc\)\]/);
    expect(schema).toMatch(/@@index\(\[webhookId, createdAt\(sort: Desc\)\]/);
  });

  it('mirrors the schema indexes in an idempotent migration', () => {
    for (const index of expectedIndexes) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS "${index}"`);
    }
    expect(migration).toMatch(/ANALYZE/);
  });
});
