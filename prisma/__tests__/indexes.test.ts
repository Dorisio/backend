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
