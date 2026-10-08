/**
 * Content moderation types (issue #62).
 *
 * A report is filed against a *target* (`tip`, `user` or `creator`) by a
 * reporter, triaged automatically, investigated by an admin, and resolved with a
 * decision that is recorded in the append-only moderation audit trail. Content
 * can be hidden while a report is open and restored or removed when it closes,
 * and the affected author can appeal the decision once.
 */

import { z } from 'zod';

export const REPORT_TARGET_TYPES = ['tip', 'user', 'creator'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_TYPES = ['spam', 'harassment', 'inappropriate', 'fraud', 'copyright'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** `reported → investigating → resolved`, plus `dismissed` for duplicates/withdrawals. */
export const REPORT_STATUSES = ['reported', 'investigating', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_DECISIONS = ['none', 'approved', 'denied'] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

export const REPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

export const APPEAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** Moderation state of a piece of content (Tip today; the column is generic). */
export const CONTENT_STATES = ['visible', 'hidden', 'removed'] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

/** Read paths filter on this value; hidden and removed content is not served. */
export const TIP_VISIBLE_STATE: ContentState = 'visible';

export const MODERATION_ACTIONS = [
  'report.created',
  'report.auto_triaged',
  'report.claimed',
  'report.resolved',
  'report.dismissed',
  'content.hidden',
  'content.restored',
  'content.removed',
  'appeal.filed',
  'appeal.resolved',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTIONS)[number];

/**
 * Priority by report type. Harassment and fraud are read by a human first: the
 * cost of a late response is higher than a slightly noisy queue.
 */
export const PRIORITY_BY_REPORT_TYPE: Record<ReportType, ReportPriority> = {
  spam: 'low',
  inappropriate: 'normal',
  copyright: 'normal',
  harassment: 'high',
  fraud: 'urgent',
};

/** Allowed status transitions, so an invalid workflow step is a 409, not a bug. */
export const REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  reported: ['investigating', 'resolved', 'dismissed'],
  investigating: ['resolved', 'dismissed'],
  resolved: [],
  dismissed: [],
};

export function canTransition(from: ReportStatus, to: ReportStatus): boolean {
  return (REPORT_TRANSITIONS[from] ?? []).includes(to);
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as readonly string[]).includes(value);
}

export function isReportTargetType(value: unknown): value is ReportTargetType {
  return typeof value === 'string' && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

export function isContentState(value: unknown): value is ContentState {
  return typeof value === 'string' && (CONTENT_STATES as readonly string[]).includes(value);
}

export function isAppealStatus(value: unknown): value is AppealStatus {
  return typeof value === 'string' && (APPEAL_STATUSES as readonly string[]).includes(value);
}

export function isModerationAction(value: unknown): value is ModerationActionType {
  return typeof value === 'string' && (MODERATION_ACTIONS as readonly string[]).includes(value);
}

// ── Request schemas ─────────────────────────────────────────────────────────

export const CreateReportSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string().min(1).max(64),
  reportType: z.enum(REPORT_TYPES),
  reason: z.string().trim().min(3, 'Describe the problem').max(500),
  details: z.string().trim().max(2000).optional(),
});

export const ReportQueueQuerySchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  reportType: z.enum(REPORT_TYPES).optional(),
  priority: z.enum(REPORT_PRIORITIES).optional(),
  targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  assignedTo: z.string().min(1).max(64).optional(),
  /** Include everything, not only the open queue. */
  includeClosed: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((value) => value === true || value === 'true' || value === '1'),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const ResolveReportSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  resolution: z.string().trim().min(3, 'Record how the decision was reached').max(2000),
  /** What to do with the reported content as part of the resolution. */
  contentAction: z.enum(['hide', 'restore', 'remove', 'none']).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const DismissReportSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const ClaimReportSchema = z.object({
  priority: z.enum(REPORT_PRIORITIES).optional(),
});

export const AppealSchema = z.object({
  message: z.string().trim().min(10, 'Explain why the decision should be reviewed').max(2000),
});

export const AppealReviewSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
  notes: z.string().trim().min(3).max(2000),
});

export const ModerateContentSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string().min(1).max(64),
  action: z.enum(['hide', 'restore', 'remove']),
  reason: z.string().trim().min(3).max(500),
});

export type CreateReportInput = z.infer<typeof CreateReportSchema>;
export type ReportQueueQuery = z.infer<typeof ReportQueueQuerySchema>;
export type ResolveReportInput = z.infer<typeof ResolveReportSchema>;

export const DEFAULT_QUEUE_PAGE_SIZE = 20;
export const MAX_QUEUE_PAGE_SIZE = 100;
