/**
 * Moderation API (issue #62).
 *
 *   POST   /api/v1/moderation/reports                      file a report
 *   GET    /api/v1/moderation/reports/mine                 reports I filed
 *   POST   /api/v1/moderation/reports/:reportId/appeal     appeal a decision (author only)
 *
 *   GET    /api/v1/admin/moderation/queue                  triage queue (filters + paging)
 *   GET    /api/v1/admin/moderation/reports/:reportId      one report + audit trail + appeals
 *   POST   /api/v1/admin/moderation/reports/:reportId/claim    pick a report up
 *   POST   /api/v1/admin/moderation/reports/:reportId/resolve  close with a decision
 *   POST   /api/v1/admin/moderation/reports/:reportId/dismiss  close as no-action
 *   POST   /api/v1/admin/moderation/content                hide / restore / remove content
 *   GET    /api/v1/admin/moderation/appeals                appeal queue
 *   POST   /api/v1/admin/moderation/appeals/:appealId/review   accept or reject an appeal
 *   GET    /api/v1/admin/moderation/audit                  audit trail for one target
 *
 * Reporting is open to any authenticated user; everything under
 * `/api/v1/admin/moderation` runs behind `requireAdmin`. Every write goes
 * through `ModerationService`, which is the only place that moves a report
 * through its states and appends to the audit trail.
 */

import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { UnauthorizedError, ValidationError } from '../../utils/errors';
import { createModerationService } from './moderation.service';
import {
  APPEAL_STATUSES,
  AppealReviewSchema,
  AppealSchema,
  ClaimReportSchema,
  CreateReportSchema,
  DismissReportSchema,
  ModerateContentSchema,
  ReportQueueQuerySchema,
  ResolveReportSchema,
  isAppealStatus,
  type AppealStatus,
} from './moderation.types';

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      'Invalid moderation request',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    );
  }
  return parsed.data;
}

function requireUser(request: { user?: { userId: string } }): string {
  const userId = request.user?.userId;
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

export function registerModerationRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const moderation = createModerationService(prisma);

  // ── Reporting ──────────────────────────────────────────────────────────────

  app.post('/api/v1/moderation/reports', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    const input = parseOrThrow(CreateReportSchema, request.body);

    const report = await moderation.createReport(userId, input);

    // The triage result is returned so the reporter can see that spam reports are
    // picked up automatically instead of silently queued.
    return reply.code(201).send({
      report,
      triage: {
        autoFlagged: report.autoFlagged,
        score: report.spamScore,
        priority: report.priority,
        autoHidden: report.status === 'investigating' && report.spamScore >= 80,
      },
    });
  });

  app.get('/api/v1/moderation/reports/mine', { preHandler: authMiddleware }, async (request, reply) => {
    const userId = requireUser(request);
    return reply.send({ reports: await moderation.listMyReports(userId) });
  });

  app.post<{ Params: { reportId: string } }>(
    '/api/v1/moderation/reports/:reportId/appeal',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const userId = requireUser(request);
      const input = parseOrThrow(AppealSchema, request.body);

      const appeal = await moderation.fileAppeal(userId, request.params.reportId, input);
      return reply.code(201).send({ appeal });
    }
  );

  // ── Admin queue ────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/moderation/queue', { preHandler: requireAdmin }, async (request, reply) => {
    const query = parseOrThrow(ReportQueueQuerySchema, request.query ?? {});
    return reply.send(await moderation.listQueue(query));
  });

  app.get<{ Params: { reportId: string } }>(
    '/api/v1/admin/moderation/reports/:reportId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const adminUserId = requireUser(request);
      return reply.send(await moderation.getReport(adminUserId, request.params.reportId));
    }
  );

  app.post<{ Params: { reportId: string } }>(
    '/api/v1/admin/moderation/reports/:reportId/claim',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const adminUserId = requireUser(request);
      const input = parseOrThrow(ClaimReportSchema, request.body ?? {});
      const report = await moderation.claimReport(adminUserId, request.params.reportId, input);
      return reply.send({ report });
    }
  );

  app.post<{ Params: { reportId: string } }>(
    '/api/v1/admin/moderation/reports/:reportId/resolve',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const adminUserId = requireUser(request);
      const input = parseOrThrow(ResolveReportSchema, request.body);
      const report = await moderation.resolveReport(adminUserId, request.params.reportId, input);
      return reply.send({ report });
    }
  );

  app.post<{ Params: { reportId: string } }>(
    '/api/v1/admin/moderation/reports/:reportId/dismiss',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const adminUserId = requireUser(request);
      const input = parseOrThrow(DismissReportSchema, request.body);
      const report = await moderation.dismissReport(adminUserId, request.params.reportId, input);
      return reply.send({ report });
    }
  );

  app.post('/api/v1/admin/moderation/content', { preHandler: requireAdmin }, async (request, reply) => {
    const adminUserId = requireUser(request);
    const input = parseOrThrow(ModerateContentSchema, request.body);

    const result = await moderation.moderateContent(adminUserId, input);
    return reply.send(result);
  });

  // ── Appeals ────────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/moderation/appeals', { preHandler: requireAdmin }, async (request, reply) => {
    const raw = (request.query ?? {}) as { status?: string };
    if (raw.status !== undefined && !isAppealStatus(raw.status)) {
      throw new ValidationError('status must be one of pending, accepted, rejected', {
        allowed: APPEAL_STATUSES,
      });
    }

    return reply.send({ appeals: await moderation.listAppeals(raw.status as AppealStatus | undefined) });
  });

  app.post<{ Params: { appealId: string } }>(
    '/api/v1/admin/moderation/appeals/:appealId/review',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const adminUserId = requireUser(request);
      const input = parseOrThrow(AppealReviewSchema, request.body);

      const appeal = await moderation.reviewAppeal(adminUserId, request.params.appealId, input);
      return reply.send({ appeal });
    }
  );

  // ── Audit ──────────────────────────────────────────────────────────────────

  app.get('/api/v1/admin/moderation/audit', { preHandler: requireAdmin }, async (request, reply) => {
    const raw = (request.query ?? {}) as { targetType?: string; targetId?: string };
    const input = parseOrThrow(
      z.object({
        targetType: z.enum(['tip', 'user', 'creator']),
        targetId: z.string().min(1).max(64),
      }),
      raw
    );

    const audit = await moderation.getAuditTrail(input.targetType, input.targetId);
    const state = await moderation.getContentState(input.targetType, input.targetId);

    return reply.send({ targetType: input.targetType, targetId: input.targetId, state, audit });
  });
}
