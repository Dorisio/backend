import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import {
  DEFAULT_PAGE_SIZE,
  formatOffsetPaginatedResult,
  sanitizePageNumber,
  sanitizePageSize,
} from '../../utils/pagination';
import { isValidStellarPublicKey, validatePaymentAmount } from '../../lib/stellar/validation';
import {
  AddTeamMemberInput,
  CreateTeamInput,
  DistributeRevenueInput,
  RecordContributionInput,
  RequestTeamPayoutInput,
  SetPayoutAccountInput,
  SetRevenueSplitsInput,
  TEAM_LIMITS,
  TOTAL_SHARE_BPS,
  TeamAuditAction,
  TeamAuditLogView,
  TeamDashboardStats,
  TeamDetail,
  TeamListQuery,
  TeamMemberSummary,
  TeamMemberStatus,
  TeamPayoutMode,
  TeamPayoutStatus,
  TeamProfile,
  TeamRevenueSplitSummary,
  TeamRole,
  UpdateTeamInput,
  UpdateTeamMemberInput,
  UpdateTeamPayoutStatusInput,
  VerifyTeamInput,
  bpsToPercent,
  canDistributeRevenue,
  canGrantTeamRole,
  canManageMembers,
  canManagePayouts,
  canManageSplits,
  canManageTeam,
  canRecordContributionForOthers,
  canViewAuditLogs,
  normalizeTeamSlug,
  roundAmount,
} from './team.types';

/**
 * Columns exposed by the public team profile.
 */
const TEAM_PROFILE_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  avatar: true,
  verified: true,
  verifiedAt: true,
  verificationNote: true,
  isPublic: true,
  payoutMode: true,
  payoutWalletAddress: true,
  payoutWalletVerified: true,
  totalEarnings: true,
  pendingBalance: true,
  reservedBalance: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Membership row plus the joined creator identity and the member's configured
 * revenue split, which is what every read path needs to render a member.
 */
const TEAM_MEMBER_SELECT = {
  id: true,
  teamId: true,
  creatorId: true,
  role: true,
  status: true,
  contributionCount: true,
  contributionAmount: true,
  joinedAt: true,
  removedAt: true,
  creator: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true,
      verified: true,
    },
  },
  splits: {
    where: { enabled: true },
    select: { shareBps: true, enabled: true },
  },
} as const;

/** Minimum team payout, overridable per deployment (mirrors payouts for creators). */
const DEFAULT_MIN_PAYOUT_AMOUNT = 50;

/**
 * Row shapes as returned by the `select`s above. Prisma types query results
 * precisely at the call site; these aliases keep the mapping helpers readable
 * without re-declaring every selected column.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- row aliases for Prisma select results */
type TeamRow = Record<string, any>;
type MemberRow = Record<string, any>;
type SplitRow = Record<string, any>;
type ContributionRow = Record<string, any>;
type DistributionRow = Record<string, any>;
type PayoutRow = Record<string, any>;
type AuditRow = Record<string, any>;
type AggregateRow = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export class TeamService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /* ---------------------------------------------------------------- *
   * Teams
   * ---------------------------------------------------------------- */

  /**
   * Creates a team owned by the calling creator. The creator becomes the team
   * `owner` member so membership checks (and the audit trail) start from a
   * consistent state — no team exists without at least one owner.
   */
  async createTeam(userId: string, input: CreateTeamInput): Promise<TeamProfile> {
    return this.executeWithLogging('team.create', async () => {
      const creator = await this.requireCreator(userId);
      const slug = await this.generateUniqueSlug(input.slug || normalizeTeamSlug(input.name));

      const created = await this.prisma.$transaction(async (tx) => {
        const team = await tx.creatorTeam.create({
          data: {
            name: input.name,
            slug,
            description: input.description ?? null,
            avatar: input.avatar ?? null,
            isPublic: input.isPublic ?? true,
            payoutMode: (input.payoutMode ?? 'team') as TeamPayoutMode,
          },
          select: TEAM_PROFILE_SELECT,
        });

        const member = await tx.creatorTeamMember.create({
          data: {
            teamId: team.id,
            creatorId: creator.id,
            role: 'owner',
            status: 'active',
          },
          select: { id: true },
        });

        await this.recordAudit(tx, {
          teamId: team.id,
          action: TeamAuditAction.TEAM_CREATED,
          actorId: creator.id,
          actorUserId: userId,
          targetMemberId: member.id,
          targetCreatorId: creator.id,
          metadata: { name: team.name, slug: team.slug, payoutMode: team.payoutMode },
        });

        return team;
      });

      return this.toProfile(created);
    });
  }

  /**
   * Teams the creator is an active member of, newest first. Members see their
   * own role on each team so a dashboard can render the right affordances.
   */
  async listMyTeams(userId: string, query: TeamListQuery = {}) {
    return this.executeWithLogging('team.listMine', async () => {
      const creator = await this.requireCreator(userId);
      const page = sanitizePageNumber(query.page);
      const pageSize = sanitizePageSize(query.pageSize, DEFAULT_PAGE_SIZE);

      const where: Record<string, unknown> = { creatorId: creator.id, status: 'active' };
      if (query.search) {
        where.team = {
          name: { contains: query.search, mode: 'insensitive' },
        };
      }

      const [memberships, total] = await Promise.all([
        this.prisma.creatorTeamMember.findMany({
          where,
          orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            role: true,
            joinedAt: true,
            team: { select: TEAM_PROFILE_SELECT },
          },
        }),
        this.prisma.creatorTeamMember.count({ where }),
      ]);

      const items = memberships
        .filter((membership: MemberRow) => Boolean(membership.team))
        .map((membership: MemberRow) => ({
          ...this.toProfile(membership.team),
          myRole: membership.role as TeamRole,
          memberId: membership.id,
          joinedAt: this.toIso(membership.joinedAt),
        }));

      return formatOffsetPaginatedResult(items, total, page, pageSize);
    });
  }

  /** Public discovery feed of teams that opted into being listed. */
  async listPublicTeams(query: TeamListQuery = {}) {
    return this.executeWithLogging('team.listPublic', async () => {
      const page = sanitizePageNumber(query.page);
      const pageSize = sanitizePageSize(query.pageSize, DEFAULT_PAGE_SIZE);

      const where: Record<string, unknown> = { isPublic: true };
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { slug: { contains: query.search, mode: 'insensitive' } },
        ];
      }

      const [teams, total] = await Promise.all([
        this.prisma.creatorTeam.findMany({
          where,
          orderBy: [{ verified: 'desc' }, { totalEarnings: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: TEAM_PROFILE_SELECT,
        }),
        this.prisma.creatorTeam.count({ where }),
      ]);

      return formatOffsetPaginatedResult(teams.map((team: TeamRow) => this.toProfile(team)), total, page, pageSize);
    });
  }

  /**
   * Team detail. Active members get the full picture (members + splits); anyone
   * else only sees public teams, and only the public profile fields.
   */
  async getTeam(teamId: string, userId: string): Promise<TeamDetail> {
    return this.executeWithLogging('team.get', async () => {
      const creator = await this.findCreator(userId);
      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: TEAM_PROFILE_SELECT,
      });

      if (!team) {
        throw new NotFoundError('Team');
      }

      const membership = await this.findMembership(teamId, creator?.id ?? null);

      if (!membership) {
        if (!team.isPublic) {
          throw new ForbiddenError('This team profile is private');
        }
        return {
          ...this.toProfile(team),
          members: [],
          splits: { allocatedBps: 0, unallocatedBps: TOTAL_SHARE_BPS },
          viewer: { creatorId: creator?.id ?? null, role: null, isMember: false },
        };
      }

      const members = await this.loadActiveMembers(teamId);
      const summaries = this.toMemberSummaries(members);
      const allocatedBps = summaries.reduce((total, member) => total + member.shareBps, 0);

      return {
        ...this.toProfile(team),
        members: summaries,
        splits: { allocatedBps, unallocatedBps: TOTAL_SHARE_BPS - allocatedBps },
        viewer: {
          creatorId: creator?.id ?? null,
          role: membership.role as TeamRole,
          isMember: true,
        },
      };
    });
  }

  async updateTeam(userId: string, teamId: string, input: UpdateTeamInput): Promise<TeamProfile> {
    return this.executeWithLogging('team.update', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManageTeam(membership.role as string),
        'Only team owners and admins can update the team profile'
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma update payload
      const data: Record<string, any> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.avatar !== undefined) data.avatar = input.avatar;
      if (input.isPublic !== undefined) data.isPublic = input.isPublic;

      const team = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.creatorTeam.update({
          where: { id: teamId },
          data,
          select: TEAM_PROFILE_SELECT,
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.TEAM_UPDATED,
          actorId: actor.id,
          actorUserId: userId,
          metadata: { changes: input },
        });

        return updated;
      });

      return this.toProfile(team);
    });
  }

  /**
   * Platform level team verification: one verification covers every member.
   * Route level `requireAdmin` enforces that only platform admins reach this.
   */
  async verifyTeam(userId: string, teamId: string, input: VerifyTeamInput): Promise<TeamProfile> {
    return this.executeWithLogging('team.verify', async () => {
      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: { id: true },
      });

      if (!team) {
        throw new NotFoundError('Team');
      }

      const verified = input.verified ?? true;

      const updated = await this.prisma.$transaction(async (tx) => {
        const next = await tx.creatorTeam.update({
          where: { id: teamId },
          data: {
            verified,
            verifiedAt: verified ? new Date() : null,
            verificationNote: input.note ?? null,
          },
          select: TEAM_PROFILE_SELECT,
        });

        await this.recordAudit(tx, {
          teamId,
          action: verified ? TeamAuditAction.TEAM_VERIFIED : TeamAuditAction.TEAM_UNVERIFIED,
          actorUserId: userId,
          metadata: { note: input.note ?? null },
        });

        return next;
      });

      return this.toProfile(updated);
    });
  }

  /* ---------------------------------------------------------------- *
   * Members
   * ---------------------------------------------------------------- */

  /**
   * Adds (or re-activates) a creator as a team member. An optional `shareBps`
   * configures the member's revenue split in the same call; the split must fit
   * inside the currently unallocated share.
   */
  async addMember(userId: string, teamId: string, input: AddTeamMemberInput): Promise<TeamMemberSummary> {
    return this.executeWithLogging('team.member.add', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManageMembers(membership.role as string),
        'Only team owners and admins can add members'
      );

      const role = (input.role ?? 'member') as TeamRole;
      this.assertPermission(
        canGrantTeamRole(membership.role as string, role),
        `Only a team owner can assign the ${role} role`
      );

      const target = await this.resolveCreatorTarget(input);
      if (target.id === actor.id) {
        throw new ConflictError('You are already a member of this team');
      }

      const existing = await this.prisma.creatorTeamMember.findUnique({
        where: { teamId_creatorId: { teamId, creatorId: target.id } },
        select: { id: true, status: true },
      });

      if (existing?.status === 'active') {
        throw new ConflictError('This creator is already an active member of the team');
      }

      const activeCount = await this.prisma.creatorTeamMember.count({
        where: { teamId, status: 'active' },
      });
      if (activeCount >= TEAM_LIMITS.MAX_MEMBERS) {
        throw new ValidationError(`A team can have at most ${TEAM_LIMITS.MAX_MEMBERS} members`);
      }

      if (input.shareBps !== undefined) {
        const allocatedBps = await this.getAllocatedBps(teamId);
        if (allocatedBps + input.shareBps > TOTAL_SHARE_BPS) {
          throw new ValidationError(
            `Revenue split exceeds 100%. Unallocated: ${bpsToPercent(TOTAL_SHARE_BPS - allocatedBps)}%`
          );
        }
      }

      const member = await this.prisma.$transaction(async (tx) => {
        const saved = existing
          ? await tx.creatorTeamMember.update({
              where: { id: existing.id },
              data: {
                role,
                status: 'active',
                joinedAt: new Date(),
                invitedById: actor.id,
                removedAt: null,
                removedById: null,
              },
              select: TEAM_MEMBER_SELECT,
            })
          : await tx.creatorTeamMember.create({
              data: {
                teamId,
                creatorId: target.id,
                role,
                status: 'active',
                invitedById: actor.id,
              },
              select: TEAM_MEMBER_SELECT,
            });

        if (input.shareBps !== undefined) {
          await tx.teamRevenueSplit.upsert({
            where: { teamId_memberId: { teamId, memberId: saved.id } },
            create: {
              teamId,
              memberId: saved.id,
              shareBps: input.shareBps,
              enabled: true,
              updatedById: actor.id,
            },
            update: { shareBps: input.shareBps, enabled: true, updatedById: actor.id },
          });
        }

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.MEMBER_ADDED,
          actorId: actor.id,
          actorUserId: userId,
          targetMemberId: saved.id,
          targetCreatorId: target.id,
          metadata: { role, shareBps: input.shareBps ?? 0 },
        });

        return saved;
      });

      const hydrated = input.shareBps !== undefined
        ? { ...member, splits: [{ shareBps: input.shareBps, enabled: true }] }
        : member;

      return this.toMemberSummary(hydrated);
    });
  }

  /**
   * Changes a member's role or revokes their access. Guards that prevent a team
   * from losing its last owner (or members from editing themselves) live here.
   */
  async updateMember(
    userId: string,
    teamId: string,
    memberId: string,
    input: UpdateTeamMemberInput
  ): Promise<TeamMemberSummary> {
    return this.executeWithLogging('team.member.update', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManageMembers(membership.role as string),
        'Only team owners and admins can manage members'
      );

      const target = await this.requireTeamMember(teamId, memberId);

      if (target.creatorId === actor.id) {
        throw new ValidationError('You cannot change your own membership; ask another team owner');
      }

      if (input.status === 'removed') {
        await this.removeMember(userId, teamId, memberId, membership.role as string);
        const removed = await this.requireTeamMember(teamId, memberId);
        return this.toMemberSummary(removed);
      }

      const nextRole = (input.role ?? target.role) as TeamRole;

      this.assertPermission(
        canGrantTeamRole(membership.role as string, target.role as TeamRole),
        `You do not have permission to manage a member with the ${target.role} role`
      );
      this.assertPermission(
        canGrantTeamRole(membership.role as string, nextRole),
        `Only a team owner can assign the ${nextRole} role`
      );

      if (target.role === 'owner' && nextRole !== 'owner') {
        const owners = await this.prisma.creatorTeamMember.count({
          where: { teamId, status: 'active', role: 'owner' },
        });
        if (owners <= 1) {
          throw new ConflictError('A team must keep at least one owner');
        }
      }

      const member = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.creatorTeamMember.update({
          where: { id: target.id },
          data: { role: nextRole },
          select: TEAM_MEMBER_SELECT,
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.MEMBER_ROLE_CHANGED,
          actorId: actor.id,
          actorUserId: userId,
          targetMemberId: target.id,
          targetCreatorId: target.creatorId,
          metadata: { from: target.role, to: nextRole },
        });

        return updated;
      });

      return this.toMemberSummary(member);
    });
  }

  /** Revokes a member's access. The row (and its history) is kept, not deleted. */
  async removeMember(
    userId: string,
    teamId: string,
    memberId: string,
    knownActorRole?: string
  ): Promise<{ memberId: string; status: string; removedAt: string }> {
    return this.executeWithLogging('team.member.remove', async () => {
      const actor = await this.requireCreator(userId);
      const actorRole = knownActorRole ?? (await this.requireMembership(teamId, actor.id)).role;
      this.assertPermission(
        canManageMembers(actorRole as string),
        'Only team owners and admins can remove members'
      );

      const target = await this.requireTeamMember(teamId, memberId);

      if (target.creatorId === actor.id) {
        throw new ValidationError('You cannot remove yourself from the team');
      }

      this.assertPermission(
        canGrantTeamRole(actorRole as string, target.role as TeamRole),
        `You do not have permission to remove a member with the ${target.role} role`
      );

      if (target.role === 'owner') {
        const owners = await this.prisma.creatorTeamMember.count({
          where: { teamId, status: 'active', role: 'owner' },
        });
        if (owners <= 1) {
          throw new ConflictError('A team must keep at least one owner');
        }
      }

      const removedAt = new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.creatorTeamMember.update({
          where: { id: target.id },
          data: {
            status: 'removed',
            removedAt,
            removedById: actor.id,
          },
          select: { id: true },
        });

        // Freeze the member's share so it can be reallocated to someone else.
        await tx.teamRevenueSplit.updateMany({
          where: { teamId, memberId: target.id },
          data: { enabled: false },
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.MEMBER_REMOVED,
          actorId: actor.id,
          actorUserId: userId,
          targetMemberId: target.id,
          targetCreatorId: target.creatorId,
          metadata: { role: target.role },
        });
      });

      return { memberId: target.id, status: 'removed', removedAt: removedAt.toISOString() };
    });
  }

  /* ---------------------------------------------------------------- *
   * Revenue splitting
   * ---------------------------------------------------------------- */

  /** Current split configuration; every active member can read it. */
  async getRevenueSplits(teamId: string, userId: string): Promise<TeamRevenueSplitSummary> {
    return this.executeWithLogging('team.splits.get', async () => {
      const creator = await this.requireCreator(userId);
      await this.requireMembership(teamId, creator.id);

      return this.buildSplitSummary(teamId);
    });
  }

  /**
   * Replaces the whole split table. Shares are basis points and must add up to
   * at most 100%; by default every active member has to be covered explicitly
   * (pass `allowRemainder` to leave part of the revenue with the team account).
   */
  async setRevenueSplits(
    userId: string,
    teamId: string,
    input: SetRevenueSplitsInput
  ): Promise<TeamRevenueSplitSummary> {
    return this.executeWithLogging('team.splits.set', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManageSplits(membership.role as string),
        'Only team owners and admins can configure revenue splits'
      );

      const members = await this.loadActiveMembers(teamId);
      const memberById = new Map(members.map((member: MemberRow) => [member.id, member]));

      const seen = new Set<string>();
      let allocated = 0;

      for (const split of input.splits) {
        const member = memberById.get(split.memberId);
        if (!member) {
          throw new ValidationError(`Member ${split.memberId} is not an active member of this team`);
        }
        if (seen.has(split.memberId)) {
          throw new ValidationError(`Duplicate split entry for member ${split.memberId}`);
        }
        seen.add(split.memberId);
        allocated += split.shareBps;
      }

      if (allocated > TOTAL_SHARE_BPS) {
        throw new ValidationError(
          `Revenue splits add up to ${bpsToPercent(allocated)}%, which is more than 100%`
        );
      }

      if (!input.allowRemainder && seen.size !== members.length) {
        const missing = members
          .filter((member: MemberRow) => !seen.has(member.id))
          .map((member: MemberRow) => member.creator?.username ?? member.id);
        throw new ValidationError(
          `Every active member needs a split. Missing: ${missing.join(', ')}. ` +
            'Pass allowRemainder=true to leave the rest with the team account.'
        );
      }

      await this.prisma.$transaction(async (tx) => {
        for (const split of input.splits) {
          const existing = await tx.teamRevenueSplit.findUnique({
            where: { teamId_memberId: { teamId, memberId: split.memberId } },
            select: { shareBps: true, enabled: true },
          });

          const enabled = split.enabled ?? true;
          await tx.teamRevenueSplit.upsert({
            where: { teamId_memberId: { teamId, memberId: split.memberId } },
            create: {
              teamId,
              memberId: split.memberId,
              shareBps: split.shareBps,
              enabled,
              updatedById: actor.id,
            },
            update: { shareBps: split.shareBps, enabled, updatedById: actor.id },
          });

          if (!existing || existing.shareBps !== split.shareBps || existing.enabled !== enabled) {
            await this.recordAudit(tx, {
              teamId,
              action: TeamAuditAction.MEMBER_SPLIT_UPDATED,
              actorId: actor.id,
              actorUserId: userId,
              targetMemberId: split.memberId,
              targetCreatorId: memberById.get(split.memberId)?.creatorId ?? null,
              metadata: {
                from: existing ? { shareBps: existing.shareBps, enabled: existing.enabled } : null,
                to: { shareBps: split.shareBps, enabled },
              },
            });
          }
        }
      });

      return this.buildSplitSummary(teamId);
    });
  }

  /**
   * Splits an amount of revenue across the configured shares and records the
   * result. In `team` payout mode the collective balance is credited; in
   * `split` mode each member's own balance is credited instead (the remainder
   * stays with the team so nothing is lost).
   */
  async distributeRevenue(
    userId: string,
    teamId: string,
    input: DistributeRevenueInput
  ): Promise<{
    id: string;
    teamId: string;
    amount: number;
    currency: string;
    source: string;
    remainder: number;
    payoutMode: TeamPayoutMode;
    shares: Array<{ memberId: string; creatorId: string; shareBps: number; amount: number; credited: boolean }>;
    createdAt: string;
  }> {
    return this.executeWithLogging('team.revenue.distribute', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canDistributeRevenue(membership.role as string),
        'Only team owners and admins can distribute revenue'
      );

      const amountCheck = validatePaymentAmount(input.amount);
      if (!amountCheck.valid) {
        throw new ValidationError(amountCheck.reason ?? 'Invalid distribution amount');
      }
      const amount = amountCheck.value as number;

      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: { id: true, payoutMode: true },
      });
      if (!team) {
        throw new NotFoundError('Team');
      }

      const members = await this.loadActiveMembers(teamId);
      const memberById = new Map(members.map((member: MemberRow) => [member.id, member]));

      const splits = await this.prisma.teamRevenueSplit.findMany({
        where: { teamId, enabled: true },
        select: { memberId: true, shareBps: true },
      });

      const activeShares = splits.filter(
        (split: SplitRow) => split.shareBps > 0 && memberById.has(split.memberId)
      );

      if (activeShares.length === 0) {
        throw new ValidationError('No revenue splits are configured for this team');
      }

      const payoutMode = team.payoutMode as TeamPayoutMode;
      const shares = activeShares.map((split: SplitRow) => ({
        memberId: split.memberId as string,
        creatorId: (memberById.get(split.memberId) as MemberRow).creatorId as string,
        shareBps: split.shareBps as number,
        amount: roundAmount((amount * split.shareBps) / TOTAL_SHARE_BPS),
        credited: payoutMode === 'split',
      }));

      const distributed = roundAmount(shares.reduce((total, share) => total + share.amount, 0));
      const remainder = roundAmount(Math.max(0, amount - distributed));

      const distribution = await this.prisma.$transaction(async (tx) => {
        const record = await tx.teamRevenueDistribution.create({
          data: {
            teamId,
            amount,
            currency: input.currency ?? 'XLM',
            source: input.source ?? 'manual',
            reference: input.reference ?? null,
            note: input.note ?? null,
            distributedById: actor.id,
          },
          select: {
            id: true,
            teamId: true,
            amount: true,
            currency: true,
            source: true,
            createdAt: true,
          },
        });

        await tx.teamRevenueShare.createMany({
          data: shares.map((share) => ({
            distributionId: record.id,
            memberId: share.memberId,
            shareBps: share.shareBps,
            amount: share.amount,
            credited: share.credited,
          })),
        });

        if (payoutMode === 'split') {
          for (const share of shares) {
            await tx.creator.update({
              where: { id: share.creatorId },
              data: {
                pendingBalance: { increment: share.amount },
                totalEarnings: { increment: share.amount },
              },
            });
          }
          if (remainder > 0) {
            await tx.creatorTeam.update({
              where: { id: teamId },
              data: {
                pendingBalance: { increment: remainder },
                totalEarnings: { increment: remainder },
              },
            });
          }
        } else {
          await tx.creatorTeam.update({
            where: { id: teamId },
            data: {
              pendingBalance: { increment: amount },
              totalEarnings: { increment: amount },
            },
          });
        }

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.REVENUE_DISTRIBUTED,
          actorId: actor.id,
          actorUserId: userId,
          metadata: {
            distributionId: record.id,
            amount,
            payoutMode,
            remainder,
            shares: shares.map((share) => ({
              memberId: share.memberId,
              shareBps: share.shareBps,
              amount: share.amount,
            })),
          },
        });

        return record;
      });

      return {
        id: distribution.id as string,
        teamId,
        amount,
        currency: (distribution.currency as string) ?? 'XLM',
        source: (distribution.source as string) ?? 'manual',
        remainder,
        payoutMode,
        shares,
        createdAt: this.toIso(distribution.createdAt) as string,
      };
    });
  }

  /* ---------------------------------------------------------------- *
   * Contributions
   * ---------------------------------------------------------------- */

  /** Records a contribution. Members may only log their own work. */
  async recordContribution(
    userId: string,
    teamId: string,
    input: RecordContributionInput
  ): Promise<{
    id: string;
    teamId: string;
    memberId: string;
    type: string;
    amount: number;
    weight: number;
    occurredAt: string;
    contributionCount: number;
    contributionAmount: number;
  }> {
    return this.executeWithLogging('team.contribution.record', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);

      const memberId = input.memberId ?? membership.id;
      if (memberId !== membership.id) {
        this.assertPermission(
          canRecordContributionForOthers(membership.role as string),
          'Only team owners and admins can record contributions for other members'
        );
      }

      const member = await this.requireTeamMember(teamId, memberId);

      const amount = input.amount ?? 0;
      if (amount > 0) {
        const amountCheck = validatePaymentAmount(amount);
        if (!amountCheck.valid) {
          throw new ValidationError(amountCheck.reason ?? 'Invalid contribution amount');
        }
      }

      const occurredAt = input.occurredAt ?? new Date();

      const result = await this.prisma.$transaction(async (tx) => {
        const contribution = await tx.teamContribution.create({
          data: {
            teamId,
            memberId: member.id,
            type: input.type,
            description: input.description ?? null,
            amount,
            weight: input.weight ?? 1,
            reference: input.reference ?? null,
            occurredAt,
            recordedById: actor.id,
          },
          select: {
            id: true,
            teamId: true,
            memberId: true,
            type: true,
            amount: true,
            weight: true,
            occurredAt: true,
          },
        });

        const updated = await tx.creatorTeamMember.update({
          where: { id: member.id },
          data: {
            contributionCount: { increment: 1 },
            contributionAmount: { increment: amount },
          },
          select: { contributionCount: true, contributionAmount: true },
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.CONTRIBUTION_RECORDED,
          actorId: actor.id,
          actorUserId: userId,
          targetMemberId: member.id,
          targetCreatorId: member.creatorId,
          metadata: { contributionId: contribution.id, type: input.type, amount, weight: input.weight ?? 1 },
        });

        return {
          contribution,
          contributionCount: (updated.contributionCount as number) ?? 0,
          contributionAmount: (updated.contributionAmount as number) ?? 0,
        };
      });

      return {
        id: result.contribution.id as string,
        teamId,
        memberId: member.id,
        type: result.contribution.type as string,
        amount,
        weight: (result.contribution.weight as number) ?? 1,
        occurredAt: this.toIso(occurredAt) as string,
        contributionCount: result.contributionCount,
        contributionAmount: result.contributionAmount,
      };
    });
  }

  /** Contribution history (newest first), optionally filtered by member/type. */
  async listContributions(
    teamId: string,
    userId: string,
    query: TeamListQuery & { memberId?: string; type?: string } = {}
  ) {
    return this.executeWithLogging('team.contribution.list', async () => {
      const creator = await this.requireCreator(userId);
      await this.requireMembership(teamId, creator.id);

      const page = sanitizePageNumber(query.page);
      const pageSize = sanitizePageSize(query.pageSize, DEFAULT_PAGE_SIZE);

      const where: Record<string, unknown> = { teamId };
      if (query.memberId) where.memberId = query.memberId;
      if (query.type) where.type = query.type;

      const [contributions, total] = await Promise.all([
        this.prisma.teamContribution.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            memberId: true,
            type: true,
            description: true,
            amount: true,
            weight: true,
            reference: true,
            occurredAt: true,
            createdAt: true,
            member: {
              select: {
                creatorId: true,
                role: true,
                creator: { select: { username: true, displayName: true } },
              },
            },
          },
        }),
        this.prisma.teamContribution.count({ where }),
      ]);

      const items = contributions.map((contribution: ContributionRow) => ({
        id: contribution.id,
        memberId: contribution.memberId,
        creatorId: contribution.member?.creatorId ?? null,
        username: contribution.member?.creator?.username ?? null,
        role: contribution.member?.role ?? null,
        type: contribution.type,
        description: contribution.description,
        amount: contribution.amount,
        weight: contribution.weight,
        reference: contribution.reference,
        occurredAt: this.toIso(contribution.occurredAt),
      }));

      return formatOffsetPaginatedResult(items, total, page, pageSize);
    });
  }

  /* ---------------------------------------------------------------- *
   * Dashboard
   * ---------------------------------------------------------------- */

  /** Collective stats for the team: members, earnings, tips, contributions, payouts. */
  async getTeamDashboard(teamId: string, userId: string): Promise<TeamDashboardStats> {
    return this.executeWithLogging('team.dashboard', async () => {
      const creator = await this.requireCreator(userId);
      await this.requireMembership(teamId, creator.id);

      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: TEAM_PROFILE_SELECT,
      });
      if (!team) {
        throw new NotFoundError('Team');
      }

      const members = await this.loadActiveMembers(teamId);
      const summaries = this.toMemberSummaries(members);
      const memberIds = members.map((member: MemberRow) => member.id as string);
      const creatorIds = members.map((member: MemberRow) => member.creatorId as string);

      const [tipStats, contributionStats, contributionByType, distributedToMembers, payoutStats, completedPayouts, openPayouts, distributions, recentDistributions, recentPayouts, recentActivity] =
        await Promise.all([
          this.prisma.tip.aggregate({
            where: { creatorId: { in: creatorIds }, status: 'confirmed' },
            _sum: { amount: true },
            _count: true,
          }),
          this.prisma.teamContribution.aggregate({
            where: { teamId },
            _sum: { amount: true },
            _count: true,
          }),
          this.prisma.teamContribution.groupBy({
            by: ['type'],
            where: { teamId },
            _count: true,
            _sum: { amount: true },
          }),
          this.prisma.teamRevenueShare.aggregate({
            where: { memberId: { in: memberIds } },
            _sum: { amount: true },
            _count: true,
          }),
          this.prisma.teamPayout.aggregate({
            where: { teamId },
            _sum: { amount: true },
            _count: true,
          }),
          this.prisma.teamPayout.aggregate({
            where: { teamId, status: 'completed' },
            _sum: { amount: true },
            _count: true,
          }),
          this.prisma.teamPayout.aggregate({
            where: { teamId, status: { in: ['pending', 'processing'] } },
            _sum: { amount: true },
          }),
          this.prisma.teamRevenueDistribution.count({ where: { teamId } }),
          this.prisma.teamRevenueDistribution.findMany({
            where: { teamId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 5,
            select: { id: true, amount: true, currency: true, source: true, createdAt: true },
          }),
          this.prisma.teamPayout.findMany({
            where: { teamId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 5,
            select: {
              id: true,
              amount: true,
              status: true,
              walletAddress: true,
              transactionHash: true,
              createdAt: true,
            },
          }),
          this.prisma.teamAuditLog.findMany({
            where: { teamId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 10,
            select: {
              id: true,
              action: true,
              actorId: true,
              targetCreatorId: true,
              metadata: true,
              createdAt: true,
            },
          }),
        ]);

      const byRole: Record<TeamRole, number> = { owner: 0, admin: 0, member: 0 };
      for (const member of summaries) {
        byRole[member.role] += 1;
      }

      const byType: Record<string, number> = {};
      for (const row of contributionByType as AggregateRow[]) {
        byType[row.type] = this.countOf(row);
      }

      const topContributors = [...summaries]
        .sort(
          (a, b) =>
            b.contributionAmount - a.contributionAmount || b.contributionCount - a.contributionCount
        )
        .slice(0, 5)
        .map((member) => ({
          memberId: member.id,
          creatorId: member.creatorId,
          username: member.username,
          count: member.contributionCount,
          amount: member.contributionAmount,
        }));

      const lastDistribution = (recentDistributions as DistributionRow[])[0];

      return {
        team: this.toProfile(team),
        members: {
          total: summaries.length,
          active: summaries.filter((member) => member.status === 'active').length,
          byRole,
          list: summaries,
        },
        earnings: {
          totalEarnings: Number(team.totalEarnings) || 0,
          pendingBalance: Number(team.pendingBalance) || 0,
          reservedBalance: Number(team.reservedBalance) || 0,
          distributedToMembers: this.sumOf(distributedToMembers, 'amount'),
          paidOut: this.sumOf(completedPayouts, 'amount'),
        },
        tips: {
          count: this.countOf(tipStats),
          amount: this.sumOf(tipStats, 'amount'),
        },
        contributions: {
          total: this.countOf(contributionStats),
          totalAmount: this.sumOf(contributionStats, 'amount'),
          byType,
          topContributors,
        },
        revenue: {
          distributions: Number(distributions) || 0,
          lastDistributionAt: lastDistribution ? this.toIso(lastDistribution.createdAt) : null,
          recent: (recentDistributions as DistributionRow[]).map((distribution) => ({
            id: distribution.id,
            amount: Number(distribution.amount) || 0,
            currency: distribution.currency,
            source: distribution.source,
            createdAt: this.toIso(distribution.createdAt) as string,
          })),
        },
        payouts: {
          total: this.countOf(payoutStats),
          completed: this.countOf(completedPayouts),
          completedAmount: this.sumOf(completedPayouts, 'amount'),
          pendingAmount: this.sumOf(openPayouts, 'amount'),
          recent: (recentPayouts as PayoutRow[]).map((payout) => ({
            id: payout.id,
            amount: Number(payout.amount) || 0,
            status: payout.status as TeamPayoutStatus,
            walletAddress: payout.walletAddress,
            transactionHash: payout.transactionHash ?? null,
            createdAt: this.toIso(payout.createdAt) as string,
          })),
        },
        recentActivity: (recentActivity as AuditRow[]).map((entry) => ({
          id: entry.id,
          action: entry.action,
          actorId: entry.actorId ?? null,
          targetCreatorId: entry.targetCreatorId ?? null,
          metadata: entry.metadata ?? null,
          createdAt: this.toIso(entry.createdAt) as string,
        })),
      };
    });
  }

  /* ---------------------------------------------------------------- *
   * Payouts
   * ---------------------------------------------------------------- */

  /**
   * Sets the team payout account (a single Stellar wallet) and how revenue is
   * held. Changing the address always resets verification.
   */
  async setPayoutAccount(
    userId: string,
    teamId: string,
    input: SetPayoutAccountInput
  ): Promise<TeamProfile> {
    return this.executeWithLogging('team.payout.account', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManagePayouts(membership.role as string),
        'Only team owners and admins can manage the team payout account'
      );

      if (!isValidStellarPublicKey(input.walletAddress)) {
        throw new ValidationError('A valid Stellar public key is required for the team payout account');
      }

      const current = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: { payoutWalletAddress: true },
      });
      if (!current) {
        throw new NotFoundError('Team');
      }

      const changed = current.payoutWalletAddress !== input.walletAddress;
      const payoutMode = (input.payoutMode ?? undefined) as TeamPayoutMode | undefined;

      const updated = await this.prisma.$transaction(async (tx) => {
        const team = await tx.creatorTeam.update({
          where: { id: teamId },
          data: {
            payoutWalletAddress: input.walletAddress,
            ...(changed ? { payoutWalletVerified: false } : {}),
            ...(payoutMode ? { payoutMode } : {}),
          },
          select: TEAM_PROFILE_SELECT,
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.PAYOUT_ACCOUNT_UPDATED,
          actorId: actor.id,
          actorUserId: userId,
          metadata: { walletAddress: input.walletAddress, changed, payoutMode: team.payoutMode },
        });

        return team;
      });

      return this.toProfile(updated);
    });
  }

  /**
   * Requests a payout from the collective balance. The amount is moved from
   * `pendingBalance` to `reservedBalance` immediately so two concurrent
   * requests can never withdraw the same funds.
   */
  async requestTeamPayout(
    userId: string,
    teamId: string,
    input: RequestTeamPayoutInput
  ): Promise<{
    id: string;
    teamId: string;
    amount: number;
    status: TeamPayoutStatus;
    walletAddress: string;
    pendingBalance: number;
    reservedBalance: number;
    createdAt: string;
  }> {
    return this.executeWithLogging('team.payout.request', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManagePayouts(membership.role as string),
        'Only team owners and admins can request team payouts'
      );

      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: {
          id: true,
          payoutMode: true,
          payoutWalletAddress: true,
          payoutWalletVerified: true,
          pendingBalance: true,
          reservedBalance: true,
        },
      });
      if (!team) {
        throw new NotFoundError('Team');
      }

      if (team.payoutMode !== 'team') {
        throw new ValidationError(
          'This team splits revenue to its members, so payouts are requested from each member account'
        );
      }

      if (!team.payoutWalletAddress) {
        throw new ValidationError('The team payout account must be configured before requesting a payout');
      }

      const minimum = Number(process.env.MIN_PAYOUT_AMOUNT) || DEFAULT_MIN_PAYOUT_AMOUNT;
      if (input.amount < minimum) {
        throw new ValidationError(`Payout amount must be at least ${minimum}`);
      }

      if (input.amount > (Number(team.pendingBalance) || 0)) {
        throw new ValidationError(
          `Payout amount exceeds the team pending balance. Available: ${Number(team.pendingBalance) || 0}`
        );
      }

      const currentPending = Number(team.pendingBalance) || 0;
      const currentReserved = Number(team.reservedBalance) || 0;

      const pendingBalance = roundAmount(currentPending - input.amount);
      const reservedBalance = roundAmount(currentReserved + input.amount);

      const payout = await this.prisma.$transaction(async (tx) => {
        const record = await tx.teamPayout.create({
          data: {
            teamId,
            amount: input.amount,
            status: 'pending',
            walletAddress: team.payoutWalletAddress as string,
            requestedById: membership.id,
          },
          select: {
            id: true,
            teamId: true,
            amount: true,
            status: true,
            walletAddress: true,
            createdAt: true,
          },
        });

        await tx.creatorTeam.update({
          where: { id: teamId },
          data: { pendingBalance, reservedBalance },
        });

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.PAYOUT_REQUESTED,
          actorId: actor.id,
          actorUserId: userId,
          metadata: {
            payoutId: record.id,
            amount: input.amount,
            walletAddress: team.payoutWalletAddress,
          },
        });

        return record;
      });

      return {
        id: payout.id as string,
        teamId,
        amount: input.amount,
        status: payout.status as TeamPayoutStatus,
        walletAddress: payout.walletAddress as string,
        pendingBalance,
        reservedBalance,
        createdAt: this.toIso(payout.createdAt) as string,
      };
    });
  }

  async listTeamPayouts(
    teamId: string,
    userId: string,
    query: TeamListQuery & { status?: string } = {}
  ) {
    return this.executeWithLogging('team.payout.list', async () => {
      const creator = await this.requireCreator(userId);
      await this.requireMembership(teamId, creator.id);

      const page = sanitizePageNumber(query.page);
      const pageSize = sanitizePageSize(query.pageSize, DEFAULT_PAGE_SIZE);

      const where: Record<string, unknown> = { teamId };
      if (query.status) where.status = query.status;

      const [payouts, total] = await Promise.all([
        this.prisma.teamPayout.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            amount: true,
            status: true,
            walletAddress: true,
            transactionHash: true,
            errorMessage: true,
            requestedById: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.teamPayout.count({ where }),
      ]);

      const items = payouts.map((payout: PayoutRow) => ({
        id: payout.id,
        amount: payout.amount,
        status: payout.status as TeamPayoutStatus,
        walletAddress: payout.walletAddress,
        transactionHash: payout.transactionHash ?? null,
        errorMessage: payout.errorMessage ?? null,
        requestedById: payout.requestedById ?? null,
        createdAt: this.toIso(payout.createdAt),
        updatedAt: this.toIso(payout.updatedAt),
      }));

      return formatOffsetPaginatedResult(items, total, page, pageSize);
    });
  }

  /**
   * Moves a team payout through its lifecycle. Only the transitions below are
   * legal; a failed payout returns its funds to the pending balance, a
   * completed one releases the reservation.
   */
  async updateTeamPayoutStatus(
    userId: string,
    teamId: string,
    payoutId: string,
    input: UpdateTeamPayoutStatusInput
  ): Promise<{ id: string; status: TeamPayoutStatus; transactionHash: string | null; errorMessage: string | null; pendingBalance: number; reservedBalance: number }> {
    return this.executeWithLogging('team.payout.status', async () => {
      const actor = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, actor.id);
      this.assertPermission(
        canManagePayouts(membership.role as string),
        'Only team owners and admins can update team payouts'
      );

      const payout = await this.prisma.teamPayout.findFirst({
        where: { id: payoutId, teamId },
        select: { id: true, amount: true, status: true },
      });
      if (!payout) {
        throw new NotFoundError('Team payout');
      }

      const current = payout.status as TeamPayoutStatus;
      const next = input.status as TeamPayoutStatus;
      const allowed: Record<TeamPayoutStatus, TeamPayoutStatus[]> = {
        pending: ['processing', 'failed'],
        processing: ['completed', 'failed'],
        completed: [],
        failed: [],
      };

      if (!allowed[current].includes(next)) {
        throw new ConflictError(`A payout in status "${current}" cannot move to "${next}"`);
      }

      const team = await this.prisma.creatorTeam.findUnique({
        where: { id: teamId },
        select: { pendingBalance: true, reservedBalance: true },
      });
      if (!team) {
        throw new NotFoundError('Team');
      }

      let pendingBalance = Number(team.pendingBalance) || 0;
      let reservedBalance = Number(team.reservedBalance) || 0;

      if (next === 'failed') {
        reservedBalance = roundAmount(reservedBalance - payout.amount);
        pendingBalance = roundAmount(pendingBalance + payout.amount);
      } else if (next === 'completed') {
        reservedBalance = roundAmount(reservedBalance - payout.amount);
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.teamPayout.update({
          where: { id: payout.id },
          data: {
            status: next,
            transactionHash: input.transactionHash ?? null,
            errorMessage: input.errorMessage ?? null,
            processedAt: next === 'completed' || next === 'failed' ? new Date() : null,
          },
          select: { id: true },
        });

        if (next === 'failed' || next === 'completed') {
          await tx.creatorTeam.update({
            where: { id: teamId },
            data: { pendingBalance, reservedBalance },
          });
        }

        await this.recordAudit(tx, {
          teamId,
          action: TeamAuditAction.PAYOUT_STATUS_CHANGED,
          actorId: actor.id,
          actorUserId: userId,
          metadata: {
            payoutId: payout.id,
            from: current,
            to: next,
            transactionHash: input.transactionHash ?? null,
            errorMessage: input.errorMessage ?? null,
          },
        });
      });

      return {
        id: payout.id,
        status: next,
        transactionHash: input.transactionHash ?? null,
        errorMessage: input.errorMessage ?? null,
        pendingBalance,
        reservedBalance,
      };
    });
  }

  /* ---------------------------------------------------------------- *
   * Audit trail
   * ---------------------------------------------------------------- */

  async listAuditLogs(
    teamId: string,
    userId: string,
    query: TeamListQuery & { action?: string } = {}
  ) {
    return this.executeWithLogging('team.audit.list', async () => {
      const creator = await this.requireCreator(userId);
      const membership = await this.requireMembership(teamId, creator.id);
      this.assertPermission(
        canViewAuditLogs(membership.role as string),
        'Only team owners and admins can read the audit trail'
      );

      const page = sanitizePageNumber(query.page);
      const pageSize = sanitizePageSize(query.pageSize, DEFAULT_PAGE_SIZE);

      const where: Record<string, unknown> = { teamId };
      if (query.action) where.action = query.action;

      const [logs, total] = await Promise.all([
        this.prisma.teamAuditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            action: true,
            actorId: true,
            actorUserId: true,
            targetMemberId: true,
            targetCreatorId: true,
            metadata: true,
            createdAt: true,
          },
        }),
        this.prisma.teamAuditLog.count({ where }),
      ]);

      const items: TeamAuditLogView[] = logs.map((log: AuditRow) => ({
        id: log.id,
        action: log.action,
        actorId: log.actorId ?? null,
        actorUserId: log.actorUserId ?? null,
        targetMemberId: log.targetMemberId ?? null,
        targetCreatorId: log.targetCreatorId ?? null,
        metadata: log.metadata ?? null,
        createdAt: this.toIso(log.createdAt) as string,
      }));

      return formatOffsetPaginatedResult(items, total, page, pageSize);
    });
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private assertPermission(allowed: boolean, message: string): void {
    if (!allowed) {
      throw new ForbiddenError(message);
    }
  }

  private async findCreator(userId: string): Promise<{ id: string; username: string } | null> {
    if (!userId) return null;
    return this.prisma.creator.findUnique({
      where: { userId },
      select: { id: true, username: true },
    });
  }

  private async requireCreator(userId: string): Promise<{ id: string; username: string }> {
    const creator = await this.findCreator(userId);
    if (!creator) {
      throw new NotFoundError('Creator profile');
    }
    return creator;
  }

  private async findMembership(teamId: string, creatorId: string | null) {
    if (!creatorId) return null;
    return this.prisma.creatorTeamMember.findFirst({
      where: { teamId, creatorId, status: 'active' },
      select: { id: true, teamId: true, creatorId: true, role: true, status: true },
    });
  }

  private async requireMembership(teamId: string, creatorId: string) {
    const membership = await this.findMembership(teamId, creatorId);
    if (!membership) {
      throw new ForbiddenError('You are not a member of this team');
    }
    return membership;
  }

  private async requireTeamMember(teamId: string, memberId: string) {
    const member = await this.prisma.creatorTeamMember.findFirst({
      where: { id: memberId, teamId },
      select: TEAM_MEMBER_SELECT,
    });
    if (!member) {
      throw new NotFoundError('Team member');
    }
    return member;
  }

  private async loadActiveMembers(teamId: string): Promise<MemberRow[]> {
    const members = await this.prisma.creatorTeamMember.findMany({
      where: { teamId, status: 'active' },
      select: TEAM_MEMBER_SELECT,
    });

    const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
    return members.sort((a: MemberRow, b: MemberRow) => {
      const byRole = (rank[a.role] ?? 3) - (rank[b.role] ?? 3);
      if (byRole !== 0) return byRole;
      return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    });
  }

  private async resolveCreatorTarget(input: AddTeamMemberInput): Promise<{ id: string; username: string }> {
    if (input.creatorId) {
      const creator = await this.prisma.creator.findUnique({
        where: { id: input.creatorId },
        select: { id: true, username: true },
      });
      if (!creator) throw new NotFoundError('Creator');
      return creator;
    }

    if (input.username) {
      const creator = await this.prisma.creator.findUnique({
        where: { username: input.username },
        select: { id: true, username: true },
      });
      if (!creator) throw new NotFoundError('Creator');
      return creator;
    }

    const user = await this.prisma.user.findUnique({
      where: { email: input.email as string },
      select: { creator: { select: { id: true, username: true } } },
    });
    if (!user?.creator) {
      throw new NotFoundError('Creator');
    }
    return user.creator;
  }

  private async getAllocatedBps(teamId: string): Promise<number> {
    const splits = await this.prisma.teamRevenueSplit.findMany({
      where: { teamId, enabled: true },
      select: { shareBps: true },
    });
    return splits.reduce((total: number, split: SplitRow) => total + split.shareBps, 0);
  }

  private async buildSplitSummary(teamId: string): Promise<TeamRevenueSplitSummary> {
    const members = await this.loadActiveMembers(teamId);
    const allocatedBps = members.reduce((total, member: MemberRow) => total + this.shareOf(member), 0);

    return {
      teamId,
      allocatedBps,
      unallocatedBps: TOTAL_SHARE_BPS - allocatedBps,
      splits: members.map((member: MemberRow) => ({
        memberId: member.id,
        creatorId: member.creatorId,
        username: member.creator?.username ?? null,
        role: member.role as TeamRole,
        shareBps: this.shareOf(member),
        sharePercent: bpsToPercent(this.shareOf(member)),
        enabled: this.shareOf(member) > 0,
      })),
    };
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    const slug = normalizeTeamSlug(base);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
      const existing = await this.prisma.creatorTeam.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }

    // Extremely unlikely: fall back to a time suffix rather than failing the request.
    return `${slug}-${Date.now().toString(36)}`;
  }

  // The transaction client is passed through so audit writes share the write
  // transaction (an audited change and its audit row commit together).
  private async recordAudit(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transaction client
    tx: any,
    entry: {
      teamId: string;
      action: string;
      actorId?: string | null;
      actorUserId?: string | null;
      targetMemberId?: string | null;
      targetCreatorId?: string | null;
      metadata?: unknown;
    }
  ): Promise<void> {
    await tx.teamAuditLog.create({
      data: {
        teamId: entry.teamId,
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorUserId: entry.actorUserId ?? null,
        targetMemberId: entry.targetMemberId ?? null,
        targetCreatorId: entry.targetCreatorId ?? null,
        ...(entry.metadata === undefined || entry.metadata === null
          ? {}
          : { metadata: entry.metadata }),
      },
    });
  }

  private toProfile(team: TeamRow): TeamProfile {
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      description: team.description ?? null,
      avatar: team.avatar ?? null,
      verified: Boolean(team.verified),
      verifiedAt: team.verifiedAt ? (this.toIso(team.verifiedAt) as string) : null,
      verificationNote: team.verificationNote ?? null,
      isPublic: Boolean(team.isPublic),
      payoutMode: (team.payoutMode ?? 'team') as TeamPayoutMode,
      payoutWalletAddress: team.payoutWalletAddress ?? null,
      payoutWalletVerified: Boolean(team.payoutWalletVerified),
      totalEarnings: Number(team.totalEarnings) || 0,
      pendingBalance: Number(team.pendingBalance) || 0,
      reservedBalance: Number(team.reservedBalance) || 0,
      createdAt: this.toIso(team.createdAt) as string,
      updatedAt: this.toIso(team.updatedAt) as string,
    };
  }

  private toMemberSummaries(members: MemberRow[]): TeamMemberSummary[] {
    return members.map((member) => this.toMemberSummary(member));
  }

  private toMemberSummary(member: MemberRow): TeamMemberSummary {
    const shareBps = this.shareOf(member);
    return {
      id: member.id,
      creatorId: member.creatorId,
      username: member.creator?.username ?? null,
      displayName: member.creator?.displayName ?? null,
      avatar: member.creator?.avatar ?? null,
      verified: Boolean(member.creator?.verified),
      role: member.role as TeamRole,
      status: (member.status ?? 'active') as TeamMemberStatus,
      shareBps,
      sharePercent: bpsToPercent(shareBps),
      contributionCount: Number(member.contributionCount) || 0,
      contributionAmount: Number(member.contributionAmount) || 0,
      joinedAt: this.toIso(member.joinedAt) as string,
    };
  }

  private shareOf(member: MemberRow): number {
    const splits = Array.isArray(member?.splits) ? member.splits : [];
    const enabled = splits.find((split: SplitRow) => split?.enabled !== false);
    return Number(enabled?.shareBps) || 0;
  }

  private toIso(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return new Date(value).toISOString();
    return null;
  }

  private countOf(result: AggregateRow): number {
    const count = result?._count;
    if (typeof count === 'number') return count;
    if (count && typeof count === 'object') {
      const values = Object.values(count as Record<string, unknown>);
      return values.reduce<number>((total, value) => total + (Number(value) || 0), 0);
    }
    return 0;
  }

  private sumOf(result: AggregateRow, field: string): number {
    const value = result?._sum?.[field];
    return Number(value) || 0;
  }
}
