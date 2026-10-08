import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { TeamService } from '../team.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../utils/errors';
import {
  TOTAL_SHARE_BPS,
  TeamAuditAction,
  type AddTeamMemberInput,
  type CreateTeamInput,
  type TeamMemberSummary,
  type TeamProfile,
} from '../team.types';
import type { PrismaClient } from '@prisma/client';
import { FakePrisma } from './fake-prisma';

/** Deterministic, structurally valid Stellar account for payout-account tests. */
const VALID_WALLET = Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey();
const OTHER_WALLET = Keypair.fromRawEd25519Seed(Buffer.alloc(32).fill(7)).publicKey();

interface Harness {
  prisma: FakePrisma;
  service: TeamService;
  createTeam: (userId?: string, input?: Partial<CreateTeamInput>) => Promise<TeamProfile>;
  addMember: (userId: string, teamId: string, input: Partial<AddTeamMemberInput>) => Promise<TeamMemberSummary>;
}

async function seedCreator(prisma: FakePrisma, userId: string, username: string, email?: string) {
  await prisma.user.create({
    data: { id: userId, email: email ?? `${username}@example.com`, name: username, role: 'creator' },
  });
  return prisma.creator.create({
    data: { id: `creator-${userId}`, userId, username, displayName: username },
  });
}

/** Owner + one member team, the starting point for most membership tests. */
async function setup(): Promise<Harness> {
  const prisma = new FakePrisma();
  const service = new TeamService(prisma as unknown as PrismaClient);

  await seedCreator(prisma, 'user-owner', 'studio-nine');
  await seedCreator(prisma, 'user-alice', 'alice');
  await seedCreator(prisma, 'user-bob', 'bob');
  await seedCreator(prisma, 'user-outsider', 'outsider');

  const createTeam = (userId = 'user-owner', input: Partial<CreateTeamInput> = {}) =>
    service.createTeam(userId, { name: 'Studio Nine', ...input });

  const addMember = (userId: string, teamId: string, input: Partial<AddTeamMemberInput>) =>
    service.addMember(userId, teamId, { creatorId: undefined, ...input });

  return { prisma, service, createTeam, addMember };
}

describe('TeamService', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  describe('createTeam', () => {
    it('creates the team with the creator as owner and audits it', async () => {
      const team = await harness.createTeam();

      expect(team.slug).toBe('studio-nine');
      expect(team.payoutMode).toBe('team');
      expect(team.verified).toBe(false);
      expect(team.pendingBalance).toBe(0);

      const membership = harness.prisma.creatorTeamMember.rows[0];
      expect(membership.role).toBe('owner');
      expect(membership.creatorId).toBe('creator-user-owner');
      expect(membership.status).toBe('active');

      expect(harness.prisma.teamAuditLog.rows[0].action).toBe(TeamAuditAction.TEAM_CREATED);
      expect(harness.prisma.teamAuditLog.rows[0].actorId).toBe('creator-user-owner');
    });

    it('derives a unique slug when the name is already taken', async () => {
      const first = await harness.createTeam();
      const second = await harness.createTeam('user-owner', { name: 'Studio Nine' });

      expect(first.slug).toBe('studio-nine');
      expect(second.slug).toBe('studio-nine-2');
    });

    it('honours an explicit slug and visibility flag', async () => {
      const team = await harness.createTeam('user-owner', {
        name: 'Studio Nine',
        slug: 'nine-studios',
        isPublic: false,
      });

      expect(team.slug).toBe('nine-studios');
      expect(team.isPublic).toBe(false);
    });

    it('requires a creator profile', async () => {
      await harness.prisma.user.create({ data: { id: 'user-fan', email: 'fan@example.com' } });

      await expect(harness.createTeam('user-fan')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('getTeam', () => {
    it('returns members and splits to an active member', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice', shareBps: 2500 });

      const detail = await harness.service.getTeam(team.id, 'user-owner');

      expect(detail.members).toHaveLength(2);
      expect(detail.members[0].role).toBe('owner');
      expect(detail.members[1].username).toBe('alice');
      expect(detail.members[1].sharePercent).toBe(25);
      expect(detail.splits).toEqual({ allocatedBps: 2500, unallocatedBps: TOTAL_SHARE_BPS - 2500 });
      expect(detail.viewer).toEqual({ creatorId: 'creator-user-owner', role: 'owner', isMember: true });
    });

    it('hides members from non-members but exposes public profile fields', async () => {
      const team = await harness.createTeam();

      const detail = await harness.service.getTeam(team.id, 'user-outsider');

      expect(detail.members).toEqual([]);
      expect(detail.viewer.isMember).toBe(false);
      expect(detail.name).toBe('Studio Nine');
    });

    it('rejects non-members for private teams', async () => {
      const team = await harness.createTeam('user-owner', { isPublic: false });

      await expect(harness.service.getTeam(team.id, 'user-outsider')).rejects.toBeInstanceOf(
        ForbiddenError
      );
    });

    it('404s for unknown teams', async () => {
      await expect(harness.service.getTeam('team_missing', 'user-owner')).rejects.toBeInstanceOf(
        NotFoundError
      );
    });
  });

  describe('addMember', () => {
    it('adds a member with a revenue split and audits the change', async () => {
      const team = await harness.createTeam();

      const member = await harness.addMember('user-owner', team.id, {
        creatorId: 'creator-user-alice',
        role: 'member',
        shareBps: 3000,
      });

      expect(member.username).toBe('alice');
      expect(member.shareBps).toBe(3000);
      expect(member.sharePercent).toBe(30);
      expect(harness.prisma.teamRevenueSplit.rows).toHaveLength(1);

      const audit = harness.prisma.teamAuditLog.rows.at(-1);
      expect(audit.action).toBe(TeamAuditAction.MEMBER_ADDED);
      expect(audit.targetCreatorId).toBe('creator-user-alice');
    });

    it('resolves the target creator by username or email', async () => {
      const team = await harness.createTeam();

      const byUsername = await harness.addMember('user-owner', team.id, { username: 'alice' });
      const byEmail = await harness.addMember('user-owner', team.id, { email: 'bob@example.com' });

      expect(byUsername.creatorId).toBe('creator-user-alice');
      expect(byEmail.creatorId).toBe('creator-user-bob');
    });

    it('lets an admin add plain members but not other admins', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, {
        creatorId: 'creator-user-alice',
        role: 'admin',
      });

      const added = await harness.addMember('user-alice', team.id, {
        creatorId: 'creator-user-bob',
        role: 'member',
      });
      expect(added.role).toBe('member');

      await expect(
        harness.addMember('user-alice', team.id, { username: 'outsider', role: 'admin' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects members with an insufficient team role', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.addMember('user-alice', team.id, { username: 'bob' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects duplicates, unknown creators and non-members', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.addMember('user-owner', team.id, { username: 'alice' })
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        harness.addMember('user-owner', team.id, { username: 'nobody' })
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        harness.addMember('user-outsider', team.id, { username: 'bob' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a split that exceeds the unallocated share', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice', shareBps: 8000 });

      await expect(
        harness.addMember('user-owner', team.id, { username: 'bob', shareBps: 3000 })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('reactivates a previously removed member', async () => {
      const team = await harness.createTeam();
      const member = await harness.addMember('user-owner', team.id, { username: 'alice' });
      await harness.service.removeMember('user-owner', team.id, member.id);

      const rejoined = await harness.addMember('user-owner', team.id, { username: 'alice' });

      expect(rejoined.status).toBe('active');
      expect(rejoined.id).toBe(member.id);
      expect(harness.prisma.creatorTeamMember.rows).toHaveLength(2);
    });
  });

  describe('updateMember', () => {
    it('promotes a member and records the role change', async () => {
      const team = await harness.createTeam();
      const member = await harness.addMember('user-owner', team.id, { username: 'alice' });

      const updated = await harness.service.updateMember('user-owner', team.id, member.id, {
        role: 'admin',
      });

      expect(updated.role).toBe('admin');
      const audit = harness.prisma.teamAuditLog.rows.at(-1);
      expect(audit.action).toBe(TeamAuditAction.MEMBER_ROLE_CHANGED);
      expect(audit.metadata).toEqual({ from: 'member', to: 'admin' });
    });

    it('stops a member from editing their own membership', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];

      await expect(
        harness.service.updateMember('user-owner', team.id, owner.id, { role: 'member' })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('stops an admin from demoting an owner', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.addMember('user-owner', team.id, { username: 'alice', role: 'admin' });

      await expect(
        harness.service.updateMember('user-alice', team.id, owner.id, { role: 'member' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('revokes access when status is removed', async () => {
      const team = await harness.createTeam();
      const member = await harness.addMember('user-owner', team.id, { username: 'alice' });

      const removed = await harness.service.updateMember('user-owner', team.id, member.id, {
        status: 'removed',
      });

      expect(removed.status).toBe('removed');
    });
  });

  describe('removeMember', () => {
    it('keeps the row, disables the split and audits the removal', async () => {
      const team = await harness.createTeam();
      const member = await harness.addMember('user-owner', team.id, {
        username: 'alice',
        shareBps: 2000,
      });

      const result = await harness.service.removeMember('user-owner', team.id, member.id);

      expect(result.status).toBe('removed');
      expect(harness.prisma.creatorTeamMember.rows).toHaveLength(2);
      expect(harness.prisma.teamRevenueSplit.rows[0].enabled).toBe(false);
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(TeamAuditAction.MEMBER_REMOVED);
      expect(await harness.service.getRevenueSplits(team.id, 'user-owner')).toMatchObject({
        allocatedBps: 0,
        unallocatedBps: TOTAL_SHARE_BPS,
      });
    });

    it('stops members from removing themselves', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice', role: 'admin' });
      const alice = harness.prisma.creatorTeamMember.rows[1];

      await expect(
        harness.service.removeMember('user-alice', team.id, alice.id)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('stops an admin from removing the owner', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.addMember('user-owner', team.id, { username: 'alice', role: 'admin' });

      await expect(
        harness.service.removeMember('user-alice', team.id, owner.id)
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('setRevenueSplits', () => {
    it('stores splits, reports the allocation and audits each change', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });

      const summary = await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [
          { memberId: owner.id, shareBps: 6000 },
          { memberId: alice.id, shareBps: 4000 },
        ],
      });

      expect(summary.allocatedBps).toBe(TOTAL_SHARE_BPS);
      expect(summary.unallocatedBps).toBe(0);
      expect(summary.splits.map((split) => split.sharePercent)).toEqual([60, 40]);
      expect(
        harness.prisma.teamAuditLog.rows.filter(
          (row) => row.action === TeamAuditAction.MEMBER_SPLIT_UPDATED
        )
      ).toHaveLength(2);
    });

    it('rejects totals above 100%', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.setRevenueSplits('user-owner', team.id, {
          splits: [
            { memberId: owner.id, shareBps: 7000 },
            { memberId: alice.id, shareBps: 7000 },
          ],
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('requires every active member to be covered unless a remainder is allowed', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.setRevenueSplits('user-owner', team.id, {
          splits: [{ memberId: owner.id, shareBps: 5000 }],
        })
      ).rejects.toBeInstanceOf(ValidationError);

      const summary = await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [{ memberId: owner.id, shareBps: 5000 }],
        allowRemainder: true,
      });
      expect(summary.unallocatedBps).toBe(5000);
    });

    it('rejects unknown members and duplicates', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];

      await expect(
        harness.service.setRevenueSplits('user-owner', team.id, {
          splits: [{ memberId: 'member_ghost', shareBps: 100 }],
        })
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        harness.service.setRevenueSplits('user-owner', team.id, {
          splits: [
            { memberId: owner.id, shareBps: 100 },
            { memberId: owner.id, shareBps: 200 },
          ],
        })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects members with an insufficient role and non-members', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.setRevenueSplits('user-alice', team.id, {
          splits: [{ memberId: owner.id, shareBps: 10000 }],
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        harness.service.getRevenueSplits(team.id, 'user-outsider')
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('distributeRevenue', () => {
    const splitEvenly = async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [
          { memberId: owner.id, shareBps: 4000 },
          { memberId: alice.id, shareBps: 6000 },
        ],
      });
      return { team, owner, alice };
    };

    it('credits the collective balance in team payout mode', async () => {
      const { team } = await splitEvenly();

      const distribution = await harness.service.distributeRevenue('user-owner', team.id, {
        amount: 1000,
        source: 'tips',
      });

      expect(distribution.payoutMode).toBe('team');
      expect(distribution.remainder).toBe(0);
      expect(distribution.shares.map((share) => share.amount)).toEqual([400, 600]);
      expect(distribution.shares.every((share) => share.credited === false)).toBe(true);

      expect(harness.prisma.creatorTeam.rows[0].pendingBalance).toBe(1000);
      expect(harness.prisma.creatorTeam.rows[0].totalEarnings).toBe(1000);
      expect(harness.prisma.creator.rows.every((row) => row.pendingBalance === undefined)).toBe(true);
      expect(harness.prisma.teamRevenueShare.rows).toHaveLength(2);
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(
        TeamAuditAction.REVENUE_DISTRIBUTED
      );
    });

    it('credits member balances and keeps the remainder with the team in split mode', async () => {
      const team = await harness.createTeam('user-owner', { payoutMode: 'split' });
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [
          { memberId: owner.id, shareBps: 3000 },
          { memberId: alice.id, shareBps: 4000 },
        ],
        allowRemainder: true,
      });

      const distribution = await harness.service.distributeRevenue('user-owner', team.id, {
        amount: 100,
      });

      expect(distribution.remainder).toBe(30);
      const ownerCreator = harness.prisma.creator.rows.find((row) => row.id === 'creator-user-owner');
      const aliceCreator = harness.prisma.creator.rows.find((row) => row.id === 'creator-user-alice');
      expect(ownerCreator.pendingBalance).toBe(30);
      expect(aliceCreator.pendingBalance).toBe(40);
      expect(ownerCreator.totalEarnings).toBe(30);
      expect(harness.prisma.creatorTeam.rows[0].pendingBalance).toBe(30);
    });

    it('rounds shares to Stellar precision without losing value', async () => {
      const { team } = await splitEvenly();

      const distribution = await harness.service.distributeRevenue('user-owner', team.id, {
        amount: 0.0000001,
      });

      const total = distribution.shares.reduce((sum, share) => sum + share.amount, 0);
      expect(distribution.amount).toBe(0.0000001);
      expect(total + distribution.remainder).toBeCloseTo(0.0000001, 7);
    });

    it('requires configured splits, a valid amount and a manager role', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.distributeRevenue('user-owner', team.id, { amount: 10 })
      ).rejects.toBeInstanceOf(ValidationError);

      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [{ memberId: owner.id, shareBps: TOTAL_SHARE_BPS }],
        allowRemainder: true,
      });

      await expect(
        harness.service.distributeRevenue('user-owner', team.id, { amount: 0 })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        harness.service.distributeRevenue('user-alice', team.id, { amount: 10 })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('contributions', () => {
    it('records a member contribution and keeps per-member totals', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });

      await harness.service.recordContribution('user-alice', team.id, {
        type: 'development',
        amount: 250,
        weight: 5,
        description: 'Built the tip widget',
      });

      const aliceRow = harness.prisma.creatorTeamMember.rows.find((row) => row.id === alice.id);
      expect(aliceRow.contributionCount).toBe(1);
      expect(aliceRow.contributionAmount).toBe(250);
      expect(harness.prisma.creatorTeamMember.rows.find((row) => row.id === owner.id).contributionCount).toBe(0);

      const audit = harness.prisma.teamAuditLog.rows.at(-1);
      expect(audit.action).toBe(TeamAuditAction.CONTRIBUTION_RECORDED);
      expect(audit.metadata).toMatchObject({ type: 'development', amount: 250 });
    });

    it('only lets managers record contributions for someone else', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.recordContribution('user-alice', team.id, {
          memberId: owner.id,
          type: 'manual',
        })
      ).rejects.toBeInstanceOf(ForbiddenError);

      const recorded = await harness.service.recordContribution('user-owner', team.id, {
        memberId: alice.id,
        type: 'design',
        amount: 10,
      });
      expect(recorded.memberId).toBe(alice.id);
    });

    it('lists contributions with filtering and pagination metadata', async () => {
      const team = await harness.createTeam();
      const alice = await harness.addMember('user-owner', team.id, { username: 'alice' });
      await harness.service.recordContribution('user-alice', team.id, { type: 'content', amount: 5 });
      await harness.service.recordContribution('user-alice', team.id, { type: 'development', amount: 7 });

      const page = await harness.service.listContributions(team.id, 'user-owner', {
        memberId: alice.id,
        type: 'development',
      });

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({ type: 'development', amount: 7, username: 'alice' });
      expect(page.pagination).toMatchObject({ page: 1, totalPages: 1, hasNext: false });
    });
  });

  describe('dashboard', () => {
    it('summarises members, tips, contributions, revenue and payouts', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      const alice = await harness.addMember('user-owner', team.id, {
        username: 'alice',
        shareBps: 4000,
      });
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [
          { memberId: owner.id, shareBps: 6000 },
          { memberId: alice.id, shareBps: 4000 },
        ],
      });
      await harness.service.recordContribution('user-alice', team.id, {
        type: 'development',
        amount: 120,
      });
      await harness.service.recordContribution('user-owner', team.id, {
        type: 'content',
        amount: 30,
      });
      await harness.service.distributeRevenue('user-owner', team.id, { amount: 500 });
      await harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: VALID_WALLET });
      await harness.service.requestTeamPayout('user-owner', team.id, { amount: 100 });

      await harness.prisma.tip.create({
        data: { creatorId: 'creator-user-owner', amount: 40, status: 'confirmed' },
      });
      await harness.prisma.tip.create({
        data: { creatorId: 'creator-user-alice', amount: 60, status: 'confirmed' },
      });
      await harness.prisma.tip.create({
        data: { creatorId: 'creator-user-alice', amount: 999, status: 'pending' },
      });

      const dashboard = await harness.service.getTeamDashboard(team.id, 'user-alice');

      expect(dashboard.members.total).toBe(2);
      expect(dashboard.members.byRole).toEqual({ owner: 1, admin: 0, member: 1 });
      expect(dashboard.tips).toEqual({ count: 2, amount: 100 });
      expect(dashboard.contributions.total).toBe(2);
      expect(dashboard.contributions.totalAmount).toBe(150);
      expect(dashboard.contributions.byType).toEqual({ development: 1, content: 1 });
      expect(dashboard.contributions.topContributors[0]).toMatchObject({
        username: 'alice',
        count: 1,
        amount: 120,
      });
      expect(dashboard.revenue.distributions).toBe(1);
      expect(dashboard.earnings.distributedToMembers).toBe(500);
      expect(dashboard.earnings.pendingBalance).toBe(400);
      expect(dashboard.earnings.reservedBalance).toBe(100);
      expect(dashboard.payouts).toMatchObject({ total: 1, completed: 0, pendingAmount: 100 });
      expect(dashboard.recentActivity.length).toBeGreaterThan(0);
    });

    it('is only available to members', async () => {
      const team = await harness.createTeam();

      await expect(
        harness.service.getTeamDashboard(team.id, 'user-outsider')
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('payout account and payouts', () => {
    it('rejects invalid Stellar addresses and resets verification when the account changes', async () => {
      const team = await harness.createTeam();

      await expect(
        harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: 'not-a-key' })
      ).rejects.toBeInstanceOf(ValidationError);

      const configured = await harness.service.setPayoutAccount('user-owner', team.id, {
        walletAddress: VALID_WALLET,
      });
      expect(configured.payoutWalletAddress).toBe(VALID_WALLET);
      expect(configured.payoutWalletVerified).toBe(false);

      harness.prisma.creatorTeam.rows[0].payoutWalletVerified = true;
      const rotated = await harness.service.setPayoutAccount('user-owner', team.id, {
        walletAddress: OTHER_WALLET,
      });
      expect(rotated.payoutWalletVerified).toBe(false);
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(
        TeamAuditAction.PAYOUT_ACCOUNT_UPDATED
      );
    });

    it('reserves funds for a payout and releases them on completion', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [{ memberId: owner.id, shareBps: TOTAL_SHARE_BPS }],
      });
      await harness.service.distributeRevenue('user-owner', team.id, { amount: 1000 });
      await harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: VALID_WALLET });

      const requested = await harness.service.requestTeamPayout('user-owner', team.id, {
        amount: 250,
      });
      expect(requested).toMatchObject({
        status: 'pending',
        walletAddress: VALID_WALLET,
        pendingBalance: 750,
        reservedBalance: 250,
      });

      const processing = await harness.service.updateTeamPayoutStatus(
        'user-owner',
        team.id,
        requested.id,
        { status: 'processing' }
      );
      expect(processing).toMatchObject({ status: 'processing', reservedBalance: 250 });

      const completed = await harness.service.updateTeamPayoutStatus(
        'user-owner',
        team.id,
        requested.id,
        { status: 'completed', transactionHash: 'abc123' }
      );
      expect(completed).toMatchObject({
        status: 'completed',
        transactionHash: 'abc123',
        pendingBalance: 750,
        reservedBalance: 0,
      });
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(
        TeamAuditAction.PAYOUT_STATUS_CHANGED
      );
    });

    it('returns reserved funds when a payout fails and blocks invalid transitions', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [{ memberId: owner.id, shareBps: TOTAL_SHARE_BPS }],
      });
      await harness.service.distributeRevenue('user-owner', team.id, { amount: 400 });
      await harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: VALID_WALLET });

      const payout = await harness.service.requestTeamPayout('user-owner', team.id, { amount: 200 });
      const failed = await harness.service.updateTeamPayoutStatus('user-owner', team.id, payout.id, {
        status: 'failed',
        errorMessage: 'network down',
      });

      expect(failed).toMatchObject({ status: 'failed', pendingBalance: 400, reservedBalance: 0 });
      await expect(
        harness.service.updateTeamPayoutStatus('user-owner', team.id, payout.id, {
          status: 'completed',
        })
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('validates the payout mode, configured account, amount and balance', async () => {
      const splitTeam = await harness.createTeam('user-owner', { payoutMode: 'split' });
      await expect(
        harness.service.requestTeamPayout('user-owner', splitTeam.id, { amount: 100 })
      ).rejects.toBeInstanceOf(ValidationError);

      const team = await harness.createTeam('user-owner', { name: 'Second Studio' });
      await expect(
        harness.service.requestTeamPayout('user-owner', team.id, { amount: 100 })
      ).rejects.toBeInstanceOf(ValidationError);

      await harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: VALID_WALLET });
      await expect(
        harness.service.requestTeamPayout('user-owner', team.id, { amount: 10 })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        harness.service.requestTeamPayout('user-owner', team.id, { amount: 5000 })
      ).rejects.toBeInstanceOf(ValidationError);

      await harness.addMember('user-owner', team.id, { username: 'alice' });
      await expect(
        harness.service.requestTeamPayout('user-alice', team.id, { amount: 100 })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('lists payouts newest first with pagination metadata', async () => {
      const team = await harness.createTeam();
      const owner = harness.prisma.creatorTeamMember.rows[0];
      await harness.service.setRevenueSplits('user-owner', team.id, {
        splits: [{ memberId: owner.id, shareBps: TOTAL_SHARE_BPS }],
      });
      await harness.service.distributeRevenue('user-owner', team.id, { amount: 1000 });
      await harness.service.setPayoutAccount('user-owner', team.id, { walletAddress: VALID_WALLET });
      await harness.service.requestTeamPayout('user-owner', team.id, { amount: 100 });
      await harness.service.requestTeamPayout('user-owner', team.id, { amount: 60 });

      const page = await harness.service.listTeamPayouts(team.id, 'user-owner', { status: 'pending' });

      expect(page.total).toBe(2);
      expect(page.items[0].amount).toBe(60);
      expect(page.pagination.totalPages).toBe(1);
    });
  });

  describe('audit trail and discovery', () => {
    it('exposes the audit trail to managers only', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      await expect(
        harness.service.listAuditLogs(team.id, 'user-alice')
      ).rejects.toBeInstanceOf(ForbiddenError);

      const page = await harness.service.listAuditLogs(team.id, 'user-owner');
      expect(page.total).toBe(2);
      expect(page.items.map((item) => item.action)).toEqual([
        TeamAuditAction.MEMBER_ADDED,
        TeamAuditAction.TEAM_CREATED,
      ]);
    });

    it('lists the teams a creator belongs to with their role', async () => {
      const team = await harness.createTeam();
      await harness.addMember('user-owner', team.id, { username: 'alice' });

      const mine = await harness.service.listMyTeams('user-alice');
      const ownerTeams = await harness.service.listMyTeams('user-owner');

      expect(mine.total).toBe(1);
      expect(mine.items[0]).toMatchObject({ id: team.id, myRole: 'member' });
      expect(ownerTeams.items[0]).toMatchObject({ myRole: 'owner' });
    });

    it('lists public teams and hides private ones', async () => {
      await harness.createTeam('user-owner', { name: 'Public Studio', isPublic: true });
      await harness.createTeam('user-owner', { name: 'Private Studio', isPublic: false });

      const page = await harness.service.listPublicTeams({ search: 'studio' });

      expect(page.total).toBe(1);
      expect(page.items[0].name).toBe('Public Studio');
    });
  });

  describe('verification', () => {
    it('verifies the team once for every member and can revoke it', async () => {
      const team = await harness.createTeam();

      const verified = await harness.service.verifyTeam('user-admin', team.id, {
        verified: true,
        note: 'KYB complete',
      });
      expect(verified.verified).toBe(true);
      expect(verified.verifiedAt).not.toBeNull();
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(TeamAuditAction.TEAM_VERIFIED);

      const revoked = await harness.service.verifyTeam('user-admin', team.id, { verified: false });
      expect(revoked.verified).toBe(false);
      expect(revoked.verifiedAt).toBeNull();
      expect(harness.prisma.teamAuditLog.rows.at(-1).action).toBe(TeamAuditAction.TEAM_UNVERIFIED);
    });

    it('404s for unknown teams', async () => {
      await expect(
        harness.service.verifyTeam('user-admin', 'team_missing', { verified: true })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
