/**
 * Content moderation service (issue #62).
 *
 * One place owns the lifecycle: a report is filed, automatically scored, queued,
 * investigated, resolved with a recorded decision, appealed once, and every step
 * is appended to the moderation audit trail. Content can be hidden while a report
 * is open, restored, or removed — and only a service ever writes `Report.status`,
 * so an invalid workflow step is a 409 rather than a silent state change.
 */

import type { PrismaClient } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { enqueueEmail } from '../notifications/email';
import { AUTO_HIDE_SCORE, AUTO_INVESTIGATE_SCORE, scoreReportFields } from './spam-filter';
import {
  DEFAULT_QUEUE_PAGE_SIZE,
  MAX_QUEUE_PAGE_SIZE,
  canTransition,
  type AppealStatus,
  type ContentState,
  type CreateReportInput,
  type ReportDecision,
  type ReportPriority,
  type ReportQueueQuery,
  type ReportStatus,
  type ReportTargetType,
  type ReportType,
  type ResolveReportInput,
} from './moderation.types';

export const PRIORITY_RANK: Record<ReportPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface ModerationReportView {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reportType: ReportType;
  reason: string;
  details: string | null;
  status: ReportStatus;
  decision: ReportDecision;
  priority: ReportPriority;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  assignedTo: string | null;
  autoFlagged: boolean;
  spamScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationQueue {
  items: ModerationReportView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** Counts per status over the whole queue, not just this page. */
  counts: Record<ReportStatus, number>;
}

/** Resolution notice to the reporter. Injectable so tests need no queue. */
export interface ModerationNotifier {
  notifyReporter(input: {
    reportId: string;
    reporterId: string;
    reporterEmail: string;
    decision: ReportDecision;
    resolution: string;
    targetType: ReportTargetType;
    targetId: string;
  }): Promise<void>;
}

/**
 * Default notifier: queues the existing 'notification' email, tagged with the
 * `report.resolved` event type so the email worker's preference check applies.
 */
export const queuedModerationNotifier: ModerationNotifier = {
  async notifyReporter(input) {
    const decision = input.decision === 'approved' ? 'upheld' : 'not upheld';
    await enqueueEmail({
      to: input.reporterEmail,
      template: 'notification',
      userId: input.reporterId,
      eventType: 'report.resolved',
      data: {
        subject: `Your report was reviewed: ${decision}`,
        message: `A report you filed was ${decision}: ${input.resolution}`,
      },
    });
  },
};

export interface ModerationServiceOptions {
  now?: () => number;
  notifier?: ModerationNotifier;
}

interface ReportRow {
  id: string;
  reporterId: string;
  targetType: string;
  targetId: string;
  reportType: string;
  reason: string;
  details: string | null;
  status: string;
  decision: string;
  priority: string;
  priorityRank: number;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  assignedTo: string | null;
  autoFlagged: boolean;
  spamScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export class ModerationService {
  private readonly now: () => number;
  private readonly notifier: ModerationNotifier;

  constructor(
    private readonly prisma: PrismaClient,
    options: ModerationServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.notifier = options.notifier ?? queuedModerationNotifier;
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  async createReport(reporterId: string, input: CreateReportInput): Promise<ModerationReportView> {
    await this.requireTarget(input.targetType, input.targetId);

    // One open report per reporter per target: repeat reports are noise, and the
    // second one would carry no new information.
    const existing = await this.prisma.report.findFirst({
      where: {
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reportType: input.reportType,
        status: { in: ['reported', 'investigating'] },
      },
    });
    if (existing) {
      throw new ConflictError('You already have an open report for this content', {
        reportId: existing.id,
      });
    }

    const verdict = scoreReportFields({
      reason: input.reason,
      details: input.details,
      reportType: input.reportType,
    });

    const status: ReportStatus = verdict.score >= AUTO_INVESTIGATE_SCORE ? 'investigating' : 'reported';
    const now = new Date(this.now());

    const report = (await this.createRow({
      reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reportType: input.reportType,
      reason: input.reason,
      details: input.details ?? null,
      status,
      decision: 'none',
      priority: verdict.priority,
      priorityRank: PRIORITY_RANK[verdict.priority],
      autoFlagged: verdict.spam,
      spamScore: verdict.score,
      spamSignals: verdict.reasons,
    })) as ReportRow;

    await this.record('report.created', {
      reportId: report.id,
      targetType: input.targetType,
      targetId: input.targetId,
      actorId: reporterId,
      reason: input.reason,
      metadata: { score: verdict.score, signals: verdict.reasons },
    });

    if (verdict.spam) {
      await this.record('report.auto_triaged', {
        reportId: report.id,
        targetType: input.targetType,
        targetId: input.targetId,
        actorId: 'system',
        reason: `score ${verdict.score}: ${verdict.reasons.join(', ')}`,
        metadata: { autoHide: verdict.autoHide },
      });
    }

    if (verdict.autoHide) {
      // High-confidence spam is hidden from readers while a human reviews it.
      await this.setContentState(input.targetType, input.targetId, 'hidden', 'system', {
        reportId: report.id,
        reason: `auto-hidden (score ${verdict.score} >= ${AUTO_HIDE_SCORE})`,
      });
    }

    logger.info(
      { reportId: report.id, targetType: input.targetType, status, score: verdict.score },
      'Moderation report created'
    );

    return this.toView(report, now);
  }

  async listMyReports(reporterId: string): Promise<ModerationReportView[]> {
    const rows = (await this.prisma.report.findMany({
      where: { reporterId },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    })) as ReportRow[];

    return rows.map((row) => this.toView(row));
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  /**
   * The admin queue: open reports first, most urgent and oldest first within a
   * priority. Closed reports are only included on request.
   */
  async listQueue(query: ReportQueueQuery = {}): Promise<ModerationQueue> {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(query.pageSize ?? DEFAULT_QUEUE_PAGE_SIZE, MAX_QUEUE_PAGE_SIZE);

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    else if (!query.includeClosed) where.status = { in: ['reported', 'investigating'] };
    if (query.reportType) where.reportType = query.reportType;
    if (query.priority) where.priority = query.priority;
    if (query.targetType) where.targetType = query.targetType;
    if (query.assignedTo) where.assignedTo = query.assignedTo;

    const [rows, total, ...statusCounts] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: [{ priorityRank: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.report.count({ where }),
      this.prisma.report.count({ where: { status: 'reported' } }),
      this.prisma.report.count({ where: { status: 'investigating' } }),
      this.prisma.report.count({ where: { status: 'resolved' } }),
      this.prisma.report.count({ where: { status: 'dismissed' } }),
    ]);

    const totalPages = Math.ceil(total / pageSize) || 1;

    return {
      items: (rows as ReportRow[]).map((row) => this.toView(row)),
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      counts: {
        reported: statusCounts[0],
        investigating: statusCounts[1],
        resolved: statusCounts[2],
        dismissed: statusCounts[3],
      },
    };
  }

  async getReport(adminUserId: string, reportId: string): Promise<{
    report: ModerationReportView;
    audit: Array<{ id: string; action: string; actorId: string; reason: string | null; createdAt: string }>;
    appeals: Array<{ id: string; appellantId: string; status: string; message: string; createdAt: string }>;
  }> {
    await this.requireAdmin(adminUserId);

    const report = (await this.prisma.report.findUnique({ where: { id: reportId } })) as ReportRow | null;
    if (!report) throw new NotFoundError('Report');

    const [audit, appeals] = await Promise.all([
      this.prisma.moderationAction.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      this.prisma.reportAppeal.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' }, take: 20 }),
    ]);

    return {
      report: this.toView(report),
      audit: audit.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorId: entry.actorId,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
      appeals: appeals.map((appeal) => ({
        id: appeal.id,
        appellantId: appeal.appellantId,
        status: appeal.status,
        message: appeal.message,
        createdAt: appeal.createdAt.toISOString(),
      })),
    };
  }

  /** Picks a report up, so two admins do not investigate the same one. */
  async claimReport(
    adminUserId: string,
    reportId: string,
    input: { priority?: ReportPriority } = {}
  ): Promise<ModerationReportView> {
    await this.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);

    if (report.assignedTo && report.assignedTo !== adminUserId) {
      throw new ConflictError('This report is already assigned to another moderator', {
        assignedTo: report.assignedTo,
      });
    }

    const priority = input.priority ?? (report.priority as ReportPriority);
    const transitioned = report.status === 'reported';

    const updated = (await this.prisma.report.update({
      where: { id: reportId },
      data: {
        assignedTo: adminUserId,
        ...(transitioned ? { status: 'investigating' } : {}),
        priority,
        priorityRank: PRIORITY_RANK[priority],
      },
    })) as ReportRow;

    await this.record('report.claimed', {
      reportId,
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: adminUserId,
      reason: transitioned ? 'claimed and moved to investigating' : 'claimed',
      metadata: { priority },
    });

    return this.toView(updated);
  }

  /**
   * Closes a report with a decision, optionally acting on the content. The
   * reporter is told the outcome through the notifier.
   */
  async resolveReport(
    adminUserId: string,
    reportId: string,
    input: ResolveReportInput
  ): Promise<ModerationReportView> {
    await this.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);

    if (!canTransition(report.status as ReportStatus, 'resolved')) {
      throw new ConflictError(`A ${report.status} report cannot be resolved again`, {
        status: report.status,
      });
    }

    const now = new Date(this.now());
    const updated = (await this.prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'resolved',
        decision: input.decision,
        resolution: input.resolution,
        resolvedBy: adminUserId,
        resolvedAt: now,
        assignedTo: report.assignedTo ?? adminUserId,
      },
    })) as ReportRow;

    await this.record('report.resolved', {
      reportId,
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: adminUserId,
      reason: input.resolution,
      metadata: { decision: input.decision, notes: input.notes ?? null },
    });

    if (input.contentAction && input.contentAction !== 'none') {
      await this.setContentState(
        report.targetType as ReportTargetType,
        report.targetId,
        input.contentAction === 'restore' ? 'visible' : input.contentAction === 'remove' ? 'removed' : 'hidden',
        adminUserId,
        { reportId, reason: `${input.contentAction} on resolution` }
      );
    }

    await this.notifyReporter(report, input.decision, input.resolution, adminUserId);

    return this.toView(updated, now);
  }

  async dismissReport(
    adminUserId: string,
    reportId: string,
    input: { reason: string }
  ): Promise<ModerationReportView> {
    await this.requireAdmin(adminUserId);
    const report = await this.requireReport(reportId);

    if (!canTransition(report.status as ReportStatus, 'dismissed')) {
      throw new ConflictError(`A ${report.status} report cannot be dismissed`, { status: report.status });
    }

    const updated = (await this.prisma.report.update({
      where: { id: reportId },
      data: {
        status: 'dismissed',
        resolution: input.reason,
        resolvedBy: adminUserId,
        resolvedAt: new Date(this.now()),
      },
    })) as ReportRow;

    await this.record('report.dismissed', {
      reportId,
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: adminUserId,
      reason: input.reason,
    });

    return this.toView(updated);
  }

  // ── Content ────────────────────────────────────────────────────────────────

  /** Hides, restores or removes content and records who did it and why. */
  async moderateContent(
    actorId: string,
    input: { targetType: ReportTargetType; targetId: string; action: 'hide' | 'restore' | 'remove'; reason: string },
    options: { requireAdmin?: boolean; reportId?: string } = { requireAdmin: true }
  ): Promise<{ targetType: ReportTargetType; targetId: string; state: ContentState }> {
    if (options.requireAdmin !== false) {
      await this.requireAdmin(actorId);
    }
    await this.requireTarget(input.targetType, input.targetId);

    const state: ContentState =
      input.action === 'restore' ? 'visible' : input.action === 'remove' ? 'removed' : 'hidden';

    await this.setContentState(input.targetType, input.targetId, state, actorId, {
      reason: input.reason,
      reportId: options.reportId,
    });

    return { targetType: input.targetType, targetId: input.targetId, state };
  }

  async getContentState(targetType: ReportTargetType, targetId: string): Promise<ContentState> {
    if (targetType !== 'tip') return 'visible';

    const tip = await this.prisma.tip.findUnique({
      where: { id: targetId },
      select: { moderationState: true },
    });
    if (!tip) throw new NotFoundError('Tip');

    return (tip.moderationState as ContentState) ?? 'visible';
  }

  // ── Appeals ────────────────────────────────────────────────────────────────

  /**
   * The author of the moderated content appeals a resolved decision, once. Only
   * the affected author may appeal, and only a `resolved` report can be appealed.
   */
  async fileAppeal(
    userId: string,
    reportId: string,
    input: { message: string }
  ): Promise<{ id: string; status: AppealStatus; message: string; createdAt: string }> {
    const report = await this.requireReport(reportId);

    if (report.status !== 'resolved') {
      throw new ConflictError('Only a resolved report can be appealed', { status: report.status });
    }

    const ownerId = await this.contentOwner(report.targetType as ReportTargetType, report.targetId);
    if (ownerId !== userId) {
      throw new ForbiddenError('Only the author of the reported content can appeal');
    }

    const existing = await this.prisma.reportAppeal.findFirst({ where: { reportId } });
    if (existing) {
      throw new ConflictError('An appeal has already been filed for this report', {
        appealId: existing.id,
        status: existing.status,
      });
    }

    const appeal = await this.prisma.reportAppeal.create({
      data: { reportId, appellantId: userId, message: input.message, status: 'pending' },
    });

    await this.record('appeal.filed', {
      reportId,
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: userId,
      reason: input.message,
    });

    return {
      id: appeal.id,
      status: appeal.status as AppealStatus,
      message: appeal.message,
      createdAt: appeal.createdAt.toISOString(),
    };
  }

  async listAppeals(status?: AppealStatus): Promise<
    Array<{ id: string; reportId: string; appellantId: string; status: string; message: string; createdAt: string }>
  > {
    const appeals = await this.prisma.reportAppeal.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    return appeals.map((appeal) => ({
      id: appeal.id,
      reportId: appeal.reportId,
      appellantId: appeal.appellantId,
      status: appeal.status,
      message: appeal.message,
      createdAt: appeal.createdAt.toISOString(),
    }));
  }

  /**
   * Reviews an appeal. Accepting one restores the content and records the
   * reversal; the original decision is left in the audit trail either way.
   */
  async reviewAppeal(
    adminUserId: string,
    appealId: string,
    input: { status: Exclude<AppealStatus, 'pending'>; notes: string }
  ): Promise<{ id: string; status: AppealStatus; notes: string; reviewedAt: string }> {
    await this.requireAdmin(adminUserId);

    const appeal = await this.prisma.reportAppeal.findUnique({ where: { id: appealId } });
    if (!appeal) throw new NotFoundError('Appeal');
    if (appeal.status !== 'pending') {
      throw new ConflictError('This appeal has already been reviewed', { status: appeal.status });
    }

    const reviewedAt = new Date(this.now());
    const updated = await this.prisma.reportAppeal.update({
      where: { id: appealId },
      data: { status: input.status, notes: input.notes, reviewedBy: adminUserId, reviewedAt },
    });

    const report = await this.requireReport(appeal.reportId);

    if (input.status === 'accepted') {
      await this.setContentState(
        report.targetType as ReportTargetType,
        report.targetId,
        'visible',
        adminUserId,
        { reportId: report.id, reason: `appeal accepted: ${input.notes}` }
      );
    }

    await this.record('appeal.resolved', {
      reportId: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      actorId: adminUserId,
      reason: input.notes,
      metadata: { status: input.status },
    });

    return {
      id: updated.id,
      status: updated.status as AppealStatus,
      notes: updated.notes ?? input.notes,
      reviewedAt: reviewedAt.toISOString(),
    };
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  async getAuditTrail(
    targetType: ReportTargetType,
    targetId: string
  ): Promise<Array<{ id: string; action: string; actorId: string; reason: string | null; createdAt: string }>> {
    const entries = await this.prisma.moderationAction.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    return entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actorId: entry.actorId,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async setContentState(
    targetType: ReportTargetType,
    targetId: string,
    state: ContentState,
    actorId: string,
    options: { reason?: string; reportId?: string } = {}
  ): Promise<void> {
    if (targetType === 'tip') {
      const tip = await this.prisma.tip.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!tip) throw new NotFoundError('Tip');
      await this.prisma.tip.update({ where: { id: targetId }, data: { moderationState: state } });
    }

    const action = state === 'hidden' ? 'content.hidden' : state === 'removed' ? 'content.removed' : 'content.restored';

    await this.record(action, {
      reportId: options.reportId,
      targetType,
      targetId,
      actorId,
      reason: options.reason ?? null,
      metadata: { state },
    });
  }

  /**
   * Inserts the report row. The partial unique index on the open report
   * (reporter, target, type) is the last line of defence: two concurrent
   * submissions that both pass the pre-check collide here and the second one is
   * answered with the same 409 as the sequential path.
   */
  private async createRow(data: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.prisma.report.create({ data: data as never });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictError('You already have an open report for this content');
      }
      throw error;
    }
  }

  private async record(    action: string,
    input: {
      reportId?: string;
      targetType: string;
      targetId: string;
      actorId: string;
      reason?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.prisma.moderationAction.create({
      data: {
        reportId: input.reportId ?? null,
        action,
        targetType: input.targetType,
        targetId: input.targetId,
        actorId: input.actorId,
        reason: input.reason ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  }

  private async notifyReporter(
    report: ReportRow,
    decision: ReportDecision,
    resolution: string,
    _adminUserId: string
  ): Promise<void> {
    const reporter = await this.prisma.user.findUnique({
      where: { id: report.reporterId },
      select: { id: true, email: true },
    });
    if (!reporter) return;

    try {
      await this.notifier.notifyReporter({
        reportId: report.id,
        reporterId: reporter.id,
        reporterEmail: reporter.email,
        decision,
        resolution,
        targetType: report.targetType as ReportTargetType,
        targetId: report.targetId,
      });
    } catch (error) {
      // The decision is recorded either way; a failed notice must not undo it.
      logger.error({ err: error, reportId: report.id }, 'Failed to notify reporter of a moderation decision');
    }
  }

  private async requireAdmin(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) throw new NotFoundError('User');
    if (user.role !== 'admin') throw new ForbiddenError('Moderator role required');
  }

  private async requireReport(reportId: string): Promise<ReportRow> {
    const report = (await this.prisma.report.findUnique({ where: { id: reportId } })) as ReportRow | null;
    if (!report) throw new NotFoundError('Report');
    return report;
  }

  /** Existence check for the report target, so a report cannot point nowhere. */
  private async requireTarget(targetType: ReportTargetType, targetId: string): Promise<void> {
    if (targetType === 'tip') {
      const tip = await this.prisma.tip.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!tip) throw new NotFoundError('Tip');
      return;
    }
    if (targetType === 'user') {
      const user = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!user) throw new NotFoundError('User');
      return;
    }

    const creator = await this.prisma.creator.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!creator) throw new NotFoundError('Creator');
  }

  /** The user behind a target, for appeal ownership. */
  private async contentOwner(targetType: ReportTargetType, targetId: string): Promise<string | null> {
    if (targetType === 'tip') {
      const tip = await this.prisma.tip.findUnique({
        where: { id: targetId },
        select: { fromUserId: true },
      });
      return tip?.fromUserId ?? null;
    }
    if (targetType === 'user') return targetId;

    const creator = await this.prisma.creator.findUnique({
      where: { id: targetId },
      select: { userId: true },
    });
    return creator?.userId ?? null;
  }

  private toView(row: ReportRow, _now = new Date(this.now())): ModerationReportView {
    return {
      id: row.id,
      reporterId: row.reporterId,
      targetType: row.targetType as ReportTargetType,
      targetId: row.targetId,
      reportType: row.reportType as ReportType,
      reason: row.reason,
      details: row.details,
      status: row.status as ReportStatus,
      decision: row.decision as ReportDecision,
      priority: row.priority as ReportPriority,
      resolution: row.resolution,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      assignedTo: row.assignedTo,
      autoFlagged: row.autoFlagged,
      spamScore: row.spamScore,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export { AUTO_HIDE_SCORE, AUTO_INVESTIGATE_SCORE };

/** Single wiring point for the routes, mirroring the other domains. */
export function createModerationService(
  prisma: PrismaClient,
  options: ModerationServiceOptions = {}
): ModerationService {
  return new ModerationService(prisma, options);
}
