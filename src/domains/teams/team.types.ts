import { z } from 'zod';

/**
 * Team / organization support for creators.
 *
 * A team groups several creator accounts (each member is an existing `Creator`)
 * under one organization that can be verified once, share revenue through
 * configured splits, record per-member contributions, receive payouts into a
 * single team payout account, and keep an append-only audit trail of every
 * membership change.
 *
 * This module is deliberately dependency free (zod only) so routes, services
 * and tests can all share the exact same vocabulary.
 */

/** Roles a creator can hold inside a team, ordered from most to least privileged. */
export const TEAM_ROLES = ['owner', 'admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_MEMBER_STATUSES = ['active', 'removed'] as const;
export type TeamMemberStatus = (typeof TEAM_MEMBER_STATUSES)[number];

/** Where the collective revenue lands: the team account or each member's own balance. */
export const TEAM_PAYOUT_MODES = ['team', 'split'] as const;
export type TeamPayoutMode = (typeof TEAM_PAYOUT_MODES)[number];

export const TEAM_PAYOUT_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type TeamPayoutStatus = (typeof TEAM_PAYOUT_STATUSES)[number];

export const CONTRIBUTION_TYPES = [
  'development',
  'design',
  'content',
  'marketing',
  'community',
  'operations',
  'manual',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

/** Audit actions written for every team change. Values are part of the public contract. */
export const TeamAuditAction = {
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  TEAM_VERIFIED: 'team.verified',
  TEAM_UNVERIFIED: 'team.unverified',
  MEMBER_ADDED: 'member.added',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_SPLIT_UPDATED: 'member.split_updated',
  CONTRIBUTION_RECORDED: 'contribution.recorded',
  REVENUE_DISTRIBUTED: 'revenue.distributed',
  PAYOUT_ACCOUNT_UPDATED: 'payout.account_updated',
  PAYOUT_REQUESTED: 'payout.requested',
  PAYOUT_STATUS_CHANGED: 'payout.status_changed',
} as const;
export type TeamAuditActionValue = (typeof TeamAuditAction)[keyof typeof TeamAuditAction];

/** Revenue is split in basis points so shares are exact integers (1 bps = 0.01%). */
export const TOTAL_SHARE_BPS = 10_000;

export const TEAM_LIMITS = {
  MIN_NAME_LENGTH: 2,
  MAX_NAME_LENGTH: 60,
  MAX_DESCRIPTION_LENGTH: 280,
  MAX_SLUG_LENGTH: 40,
  MAX_MEMBERS: 25,
  MAX_PAGE_SIZE: 100,
} as const;

/* ------------------------------------------------------------------ *
 * Role helpers
 * ------------------------------------------------------------------ */

const ROLE_RANK: Record<TeamRole, number> = { owner: 3, admin: 2, member: 1 };

export const isTeamRole = (value: unknown): value is TeamRole =>
  typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);

/** True when `role` is at least as privileged as `required`. */
export const hasTeamRoleAtLeast = (role: string, required: TeamRole): boolean =>
  isTeamRole(role) && ROLE_RANK[role] >= ROLE_RANK[required];

export const isTeamOwner = (role: string): boolean => role === 'owner';

/** Team profile fields and revenue splits: owner + admin. */
export const canManageTeam = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Add/remove members and change the role of non-admin members: owner + admin. */
export const canManageMembers = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Configure revenue splits: owner + admin. */
export const canManageSplits = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Team payout account, payout requests and payout status transitions: owner + admin. */
export const canManagePayouts = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Distribute collective revenue across the configured splits: owner + admin. */
export const canDistributeRevenue = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Reading the audit trail: owner + admin. */
export const canViewAuditLogs = (role: string): boolean => hasTeamRoleAtLeast(role, 'admin');

/** Members may only record contributions for themselves; admins for anyone. */
export const canRecordContributionForOthers = (role: string): boolean =>
  hasTeamRoleAtLeast(role, 'admin');

/**
 * Only an owner may grant or revoke the `owner`/`admin` roles; an admin can only
 * touch plain members. This keeps privilege escalation impossible for admins.
 */
export const canGrantTeamRole = (actorRole: string, targetRole: TeamRole): boolean => {
  if (isTeamOwner(actorRole)) return true;
  return hasTeamRoleAtLeast(actorRole, 'admin') && targetRole === 'member';
};

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

const slugSchema = z
  .string()
  .trim()
  .min(TEAM_LIMITS.MIN_NAME_LENGTH)
  .max(TEAM_LIMITS.MAX_SLUG_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must contain lowercase letters, numbers and dashes');

export const CreateTeamSchema = z.object({
  name: z.string().trim().min(TEAM_LIMITS.MIN_NAME_LENGTH).max(TEAM_LIMITS.MAX_NAME_LENGTH),
  slug: slugSchema.optional(),
  description: z.string().trim().max(TEAM_LIMITS.MAX_DESCRIPTION_LENGTH).optional(),
  avatar: z.string().url().optional(),
  isPublic: z.boolean().optional(),
  /** Initial collective payout mode; defaults to the team payout account. */
  payoutMode: z.enum(TEAM_PAYOUT_MODES).optional(),
});

export const UpdateTeamSchema = z
  .object({
    name: z.string().trim().min(TEAM_LIMITS.MIN_NAME_LENGTH).max(TEAM_LIMITS.MAX_NAME_LENGTH).optional(),
    description: z.string().trim().max(TEAM_LIMITS.MAX_DESCRIPTION_LENGTH).optional(),
    avatar: z.string().url().optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export const AddTeamMemberSchema = z
  .object({
    /** Both are accepted; `creatorId` wins when supplied. */
    creatorId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.enum(TEAM_ROLES).default('member'),
    shareBps: z.number().int().min(0).max(TOTAL_SHARE_BPS).optional(),
  })
  .refine((value) => Boolean(value.creatorId || value.username || value.email), {
    message: 'Either creatorId, username or email must be provided',
  });

export const UpdateTeamMemberSchema = z
  .object({
    role: z.enum(TEAM_ROLES).optional(),
    /** Set to `removed` to revoke access without losing the audit trail. */
    status: z.enum(TEAM_MEMBER_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export const SetRevenueSplitsSchema = z.object({
  splits: z
    .array(
      z.object({
        memberId: z.string().min(1),
        shareBps: z.number().int().min(0).max(TOTAL_SHARE_BPS),
        enabled: z.boolean().optional(),
      })
    )
    .min(1)
    .max(TEAM_LIMITS.MAX_MEMBERS),
  /** Reject when the shares add up to more than 100%. */
  allowRemainder: z.boolean().optional(),
});

export const RecordContributionSchema = z.object({
  /** Defaults to the caller's own membership. */
  memberId: z.string().min(1).optional(),
  type: z.enum(CONTRIBUTION_TYPES),
  description: z.string().trim().max(500).optional(),
  /** Monetary value attributed to the contribution (0 for purely qualitative work). */
  amount: z.number().min(0).optional(),
  /** Non-monetary weighting, e.g. story points or hours. */
  weight: z.number().int().min(0).max(10_000).optional(),
  reference: z.string().trim().max(200).optional(),
  occurredAt: z.coerce.date().optional(),
});

export const DistributeRevenueSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().trim().min(1).max(10).optional(),
  source: z.enum(['tips', 'subscriptions', 'sponsorship', 'manual']).optional(),
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

export const VerifyTeamSchema = z.object({
  verified: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

export const SetPayoutAccountSchema = z.object({
  walletAddress: z.string().min(1),
  payoutMode: z.enum(TEAM_PAYOUT_MODES).optional(),
});

export const RequestTeamPayoutSchema = z.object({
  amount: z.number().positive(),
});

export const UpdateTeamPayoutStatusSchema = z.object({
  status: z.enum(['processing', 'completed', 'failed']),
  transactionHash: z.string().trim().max(120).optional(),
  errorMessage: z.string().trim().max(500).optional(),
});

export const TeamListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(TEAM_LIMITS.MAX_PAGE_SIZE).optional(),
  search: z.string().trim().max(120).optional(),
});

export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;
export type UpdateTeamInput = z.infer<typeof UpdateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof AddTeamMemberSchema>;
export type UpdateTeamMemberInput = z.infer<typeof UpdateTeamMemberSchema>;
export type SetRevenueSplitsInput = z.infer<typeof SetRevenueSplitsSchema>;
export type RecordContributionInput = z.infer<typeof RecordContributionSchema>;
export type DistributeRevenueInput = z.infer<typeof DistributeRevenueSchema>;
export type VerifyTeamInput = z.infer<typeof VerifyTeamSchema>;
export type SetPayoutAccountInput = z.infer<typeof SetPayoutAccountSchema>;
export type RequestTeamPayoutInput = z.infer<typeof RequestTeamPayoutSchema>;
export type UpdateTeamPayoutStatusInput = z.infer<typeof UpdateTeamPayoutStatusSchema>;
export type TeamListQuery = z.infer<typeof TeamListQuerySchema>;

/* ------------------------------------------------------------------ *
 * Response shapes
 * ------------------------------------------------------------------ */

export interface TeamProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatar: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationNote: string | null;
  isPublic: boolean;
  payoutMode: TeamPayoutMode;
  payoutWalletAddress: string | null;
  payoutWalletVerified: boolean;
  totalEarnings: number;
  pendingBalance: number;
  reservedBalance: number;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberSummary {
  id: string;
  creatorId: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  verified: boolean;
  role: TeamRole;
  status: TeamMemberStatus;
  shareBps: number;
  sharePercent: number;
  contributionCount: number;
  contributionAmount: number;
  joinedAt: string;
}

export interface TeamDetail extends TeamProfile {
  members: TeamMemberSummary[];
  viewer: { creatorId: string | null; role: TeamRole | null; isMember: boolean };
  splits: { allocatedBps: number; unallocatedBps: number };
}

export interface TeamSplitView {
  memberId: string;
  creatorId: string;
  username: string;
  role: TeamRole;
  shareBps: number;
  sharePercent: number;
  enabled: boolean;
}

export interface TeamRevenueSplitSummary {
  teamId: string;
  allocatedBps: number;
  unallocatedBps: number;
  splits: TeamSplitView[];
}

export interface TeamDashboardStats {
  team: TeamProfile;
  members: {
    total: number;
    active: number;
    byRole: Record<TeamRole, number>;
    list: TeamMemberSummary[];
  };
  earnings: {
    totalEarnings: number;
    pendingBalance: number;
    reservedBalance: number;
    distributedToMembers: number;
    paidOut: number;
  };
  tips: { count: number; amount: number };
  contributions: {
    total: number;
    totalAmount: number;
    byType: Record<string, number>;
    topContributors: Array<{
      memberId: string;
      creatorId: string;
      username: string;
      count: number;
      amount: number;
    }>;
  };
  revenue: {
    distributions: number;
    lastDistributionAt: string | null;
    recent: Array<{
      id: string;
      amount: number;
      currency: string;
      source: string;
      createdAt: string;
    }>;
  };
  payouts: {
    total: number;
    completed: number;
    completedAmount: number;
    pendingAmount: number;
    recent: Array<{
      id: string;
      amount: number;
      status: TeamPayoutStatus;
      walletAddress: string;
      transactionHash: string | null;
      createdAt: string;
    }>;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    actorId: string | null;
    targetCreatorId: string | null;
    metadata: unknown;
    createdAt: string;
  }>;
}

export interface TeamAuditLogView {
  id: string;
  action: string;
  actorId: string | null;
  actorUserId: string | null;
  targetMemberId: string | null;
  targetCreatorId: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Rounds a monetary value to Stellar's 7 decimal places, avoiding float drift. */
export const roundAmount = (value: number): number => Math.round(value * 1e7) / 1e7;

/** Converts basis points into a human readable percentage (e.g. 2550 -> 25.5). */
export const bpsToPercent = (bps: number): number => Math.round((bps / 100) * 100) / 100;

/** Builds a URL safe slug from a team name. */
export const normalizeTeamSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks so accented names slugify predictably (Café -> cafe).
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TEAM_LIMITS.MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length >= TEAM_LIMITS.MIN_NAME_LENGTH ? slug : 'team';
};
