import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Guards for the team / organization schema (#66): the models, the indexes the
 * team queries rely on and the migration that ships them all have to stay in
 * sync with the service and its tests.
 */

const schemaPath = resolve(__dirname, '../schema.prisma');
const migrationPath = resolve(__dirname, '../migrations/20260927130000_add_creator_teams/migration.sql');

const schema = readFileSync(schemaPath, 'utf8');

describe('Team schema (Issue #66)', () => {
  it('declares the team, membership, split, contribution, distribution, payout and audit models', () => {
    for (const model of [
      'model CreatorTeam {',
      'model CreatorTeamMember {',
      'model TeamRevenueSplit {',
      'model TeamContribution {',
      'model TeamRevenueDistribution {',
      'model TeamRevenueShare {',
      'model TeamPayout {',
      'model TeamAuditLog {',
    ]) {
      expect(schema).toContain(model);
    }
  });

  it('declares the team role, status, payout mode and payout status enums', () => {
    for (const definition of [
      'enum TeamRole {',
      'enum TeamMemberStatus {',
      'enum TeamPayoutMode {',
      'enum TeamPayoutStatus {',
    ]) {
      expect(schema).toContain(definition);
    }

    expect(schema).toMatch(/role\s+TeamRole\s+@default\(member\)/);
    expect(schema).toMatch(/status\s+TeamMemberStatus\s+@default\(active\)/);
    expect(schema).toMatch(/payoutMode\s+TeamPayoutMode\s+@default\(team\)/);
  });

  it('links the Creator model to its team memberships', () => {
    expect(schema).toContain('teamMemberships CreatorTeamMember[] @relation("CreatorTeamMembers")');
    expect(schema).toMatch(/creator\s+Creator\s+@relation\("CreatorTeamMembers"/);
  });

  it('keeps one membership per creator per team and one split per member', () => {
    expect(schema).toContain('@@unique([teamId, creatorId], map: "uniq_creatorTeamMember_team_creator")');
    expect(schema).toContain('@@unique([teamId, memberId], map: "uniq_teamRevenueSplit_team_member")');
  });

  it('declares the indexes the team dashboard and rosters query on', () => {
    const expectedIndexes = [
      'idx_creatorTeam_public_verified_createdAt',
      'idx_creatorTeam_totalEarnings',
      'idx_creatorTeamMember_team_status',
      'idx_creatorTeamMember_creator_status',
      'idx_teamRevenueSplit_team_enabled',
      'idx_teamContribution_team_occurredAt',
      'idx_teamContribution_team_type',
      'idx_teamContribution_member_occurredAt',
      'idx_teamRevenueDistribution_team_createdAt',
      'idx_teamRevenueShare_distribution',
      'idx_teamRevenueShare_member_createdAt',
      'idx_teamPayout_team_status',
      'idx_teamPayout_team_createdAt',
      'idx_teamPayout_status_createdAt',
      'idx_teamAuditLog_team_createdAt',
      'idx_teamAuditLog_team_action',
    ];

    for (const index of expectedIndexes) {
      expect(schema).toContain(`map: "${index}"`);
    }
  });
});

describe('Team migration (Issue #66)', () => {
  it('ships a migration for the new team tables', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

  it('creates every team table and enum', () => {
    for (const table of [
      '"CreatorTeam"',
      '"CreatorTeamMember"',
      '"TeamRevenueSplit"',
      '"TeamContribution"',
      '"TeamRevenueDistribution"',
      '"TeamRevenueShare"',
      '"TeamPayout"',
      '"TeamAuditLog"',
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }

    expect(migration).toContain(`CREATE TYPE "TeamRole" AS ENUM ('owner', 'admin', 'member')`);
    expect(migration).toContain(`CREATE TYPE "TeamMemberStatus" AS ENUM ('active', 'removed')`);
    expect(migration).toContain(`CREATE TYPE "TeamPayoutMode" AS ENUM ('team', 'split')`);
    expect(migration).toContain(
      `CREATE TYPE "TeamPayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed')`
    );
  });

  it('creates the indexes declared in the schema', () => {
    for (const index of [
      'idx_creatorTeam_public_verified_createdAt',
      'idx_creatorTeamMember_team_status',
      'idx_teamRevenueSplit_team_enabled',
      'idx_teamContribution_team_occurredAt',
      'idx_teamRevenueShare_member_createdAt',
      'idx_teamPayout_team_status',
      'idx_teamAuditLog_team_createdAt',
    ]) {
      expect(migration).toContain(`CREATE INDEX "${index}"`);
    }
  });

  it('cascades team deletion to memberships, splits, contributions and logs', () => {
    for (const constraint of [
      '"CreatorTeamMember_teamId_fkey"',
      '"CreatorTeamMember_creatorId_fkey"',
      '"TeamRevenueSplit_memberId_fkey"',
      '"TeamContribution_memberId_fkey"',
      '"TeamRevenueShare_distributionId_fkey"',
      '"TeamPayout_teamId_fkey"',
      '"TeamAuditLog_teamId_fkey"',
    ]) {
      expect(migration).toContain(constraint);
    }

    expect(migration).toMatch(/ON DELETE CASCADE/);
  });
});
