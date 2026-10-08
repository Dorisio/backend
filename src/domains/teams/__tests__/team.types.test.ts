import { describe, expect, it } from 'vitest';
import {
  AddTeamMemberSchema,
  CreateTeamSchema,
  RecordContributionSchema,
  SetRevenueSplitsSchema,
  TEAM_LIMITS,
  TOTAL_SHARE_BPS,
  UpdateTeamSchema,
  bpsToPercent,
  canDistributeRevenue,
  canGrantTeamRole,
  canManageMembers,
  canManagePayouts,
  canManageTeam,
  canViewAuditLogs,
  hasTeamRoleAtLeast,
  isTeamOwner,
  normalizeTeamSlug,
  roundAmount,
} from '../team.types';

describe('team role helpers', () => {
  it('ranks owner above admin above member', () => {
    expect(hasTeamRoleAtLeast('owner', 'admin')).toBe(true);
    expect(hasTeamRoleAtLeast('admin', 'owner')).toBe(false);
    expect(hasTeamRoleAtLeast('member', 'member')).toBe(true);
    expect(hasTeamRoleAtLeast('unknown', 'member')).toBe(false);
    expect(isTeamOwner('owner')).toBe(true);
    expect(isTeamOwner('admin')).toBe(false);
  });

  it('maps every management action to the right minimum role', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(canManageTeam(role)).toBe(true);
      expect(canManageMembers(role)).toBe(true);
      expect(canManagePayouts(role)).toBe(true);
      expect(canDistributeRevenue(role)).toBe(true);
      expect(canViewAuditLogs(role)).toBe(true);
    }

    expect(canManageTeam('member')).toBe(false);
    expect(canManageMembers('member')).toBe(false);
    expect(canDistributeRevenue('member')).toBe(false);
    expect(canViewAuditLogs('member')).toBe(false);
  });

  it('only lets owners grant privileged roles', () => {
    expect(canGrantTeamRole('owner', 'owner')).toBe(true);
    expect(canGrantTeamRole('owner', 'admin')).toBe(true);
    expect(canGrantTeamRole('admin', 'member')).toBe(true);
    expect(canGrantTeamRole('admin', 'admin')).toBe(false);
    expect(canGrantTeamRole('admin', 'owner')).toBe(false);
    expect(canGrantTeamRole('member', 'member')).toBe(false);
  });
});

describe('team helpers', () => {
  it('slugifies names and falls back for unusable input', () => {
    expect(normalizeTeamSlug('Studio Nine')).toBe('studio-nine');
    expect(normalizeTeamSlug('  Café  Crème!! ')).toBe('cafe-creme');
    expect(normalizeTeamSlug('--')).toBe('team');
    expect(normalizeTeamSlug('a'.repeat(80)).length).toBe(TEAM_LIMITS.MAX_SLUG_LENGTH);
  });

  it('converts basis points and rounds to Stellar precision', () => {
    expect(bpsToPercent(2550)).toBe(25.5);
    expect(bpsToPercent(TOTAL_SHARE_BPS)).toBe(100);
    expect(roundAmount(0.1 + 0.2)).toBe(0.3);
    expect(roundAmount(1 / 3)).toBe(0.3333333);
  });
});

describe('team request schemas', () => {
  it('accepts a minimal team and rejects malformed slugs', () => {
    expect(CreateTeamSchema.parse({ name: 'Studio Nine' }).name).toBe('Studio Nine');
    expect(() => CreateTeamSchema.parse({ name: 'Studio Nine', slug: 'Bad Slug!' })).toThrow();
    expect(() => CreateTeamSchema.parse({ name: 'x' })).toThrow();
  });

  it('requires at least one field when updating a team', () => {
    expect(() => UpdateTeamSchema.parse({})).toThrow();
    expect(UpdateTeamSchema.parse({ isPublic: false }).isPublic).toBe(false);
  });

  it('requires a creator identifier and caps shares for new members', () => {
    expect(() => AddTeamMemberSchema.parse({ role: 'member' })).toThrow();
    expect(AddTeamMemberSchema.parse({ username: 'alice' }).role).toBe('member');
    expect(() => AddTeamMemberSchema.parse({ username: 'alice', shareBps: 20_000 })).toThrow();
  });

  it('bounds splits and contribution amounts', () => {
    expect(
      SetRevenueSplitsSchema.parse({ splits: [{ memberId: 'm1', shareBps: 5000 }] }).splits
    ).toHaveLength(1);
    expect(() => SetRevenueSplitsSchema.parse({ splits: [] })).toThrow();

    const contribution = RecordContributionSchema.parse({ type: 'development' });
    expect(contribution.amount).toBeUndefined();
    expect(() => RecordContributionSchema.parse({ type: 'nope' })).toThrow();
    expect(() =>
      RecordContributionSchema.parse({ type: 'manual', amount: -1 })
    ).toThrow();
  });
});
