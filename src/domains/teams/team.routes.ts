import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ZodError, z } from 'zod';
import { TeamService } from './team.service';
import { AppError, UnauthorizedError } from '../../utils/errors';
import { formatError, formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import {
  AddTeamMemberSchema,
  CreateTeamSchema,
  DistributeRevenueSchema,
  RecordContributionSchema,
  RequestTeamPayoutSchema,
  SetPayoutAccountSchema,
  SetRevenueSplitsSchema,
  TEAM_PAYOUT_STATUSES,
  TeamListQuerySchema,
  UpdateTeamMemberSchema,
  UpdateTeamPayoutStatusSchema,
  UpdateTeamSchema,
  VerifyTeamSchema,
} from './team.types';

type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Normalizes domain errors (and zod validation failures) into the standard
 * error envelope so every team endpoint fails the same way as the rest of the
 * API. Unexpected errors are rethrown for the global handler.
 */
const withErrorHandling = (handler: RouteHandler): RouteHandler => async (request, reply) => {
  try {
    await handler(request, reply);
  } catch (error) {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(formatError(error.message, error.code));
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send(
        formatError('Invalid request payload', 'VALIDATION_ERROR', {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      );
      return;
    }
    throw error;
  }
};

const requireUserId = (request: FastifyRequest): string => {
  const user = request.user;
  if (!user) {
    throw new UnauthorizedError('Authentication is required');
  }
  return user.userId;
};

const ContributionQuerySchema = TeamListQuerySchema.extend({
  memberId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
});

const PayoutQuerySchema = TeamListQuerySchema.extend({
  status: z.enum(TEAM_PAYOUT_STATUSES).optional(),
});

const AuditQuerySchema = TeamListQuerySchema.extend({
  action: z.string().min(1).optional(),
});

/**
 * Team / organization endpoints for creators: membership, revenue splits,
 * contributions, collective dashboard, verification and team payouts.
 */
export const registerTeamRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const teamService = new TeamService(prisma);
  const auth = { preHandler: authMiddleware };

  // GET /api/v1/teams - teams the authenticated creator belongs to
  app.get(
    '/api/v1/teams',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const query = TeamListQuerySchema.parse(request.query);
      reply.send(formatSuccess(await teamService.listMyTeams(userId, query)));
    })
  );

  // POST /api/v1/teams - create a team (creator becomes the owner)
  app.post(
    '/api/v1/teams',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const body = CreateTeamSchema.parse(request.body);
      reply.code(201).send(formatSuccess(await teamService.createTeam(userId, body)));
    })
  );

  // GET /api/v1/teams/public - discovery feed of public teams
  app.get(
    '/api/v1/teams/public',
    withErrorHandling(async (request, reply) => {
      const query = TeamListQuerySchema.parse(request.query);
      reply.send(formatSuccess(await teamService.listPublicTeams(query)));
    })
  );

  // GET /api/v1/teams/:id - team detail (members see members + splits)
  app.get(
    '/api/v1/teams/:id',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      reply.send(formatSuccess(await teamService.getTeam(id, userId)));
    })
  );

  // PATCH /api/v1/teams/:id - update team profile (owner/admin)
  app.patch(
    '/api/v1/teams/:id',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = UpdateTeamSchema.parse(request.body);
      reply.send(formatSuccess(await teamService.updateTeam(userId, id, body)));
    })
  );

  // POST /api/v1/teams/:id/verify - platform level verification (admin only)
  app.post(
    '/api/v1/teams/:id/verify',
    { preHandler: requireAdmin },
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = VerifyTeamSchema.parse(request.body ?? {});
      reply.send(formatSuccess(await teamService.verifyTeam(userId, id, body)));
    })
  );

  // POST /api/v1/teams/:id/members - add a creator to the team
  app.post(
    '/api/v1/teams/:id/members',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = AddTeamMemberSchema.parse(request.body);
      reply.code(201).send(formatSuccess(await teamService.addMember(userId, id, body)));
    })
  );

  // PATCH /api/v1/teams/:id/members/:memberId - change a member's role/status
  app.patch(
    '/api/v1/teams/:id/members/:memberId',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id, memberId } = request.params as { id: string; memberId: string };
      const body = UpdateTeamMemberSchema.parse(request.body);
      reply.send(formatSuccess(await teamService.updateMember(userId, id, memberId, body)));
    })
  );

  // DELETE /api/v1/teams/:id/members/:memberId - revoke a member's access
  app.delete(
    '/api/v1/teams/:id/members/:memberId',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id, memberId } = request.params as { id: string; memberId: string };
      reply.send(formatSuccess(await teamService.removeMember(userId, id, memberId)));
    })
  );

  // GET /api/v1/teams/:id/splits - current revenue split configuration
  app.get(
    '/api/v1/teams/:id/splits',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      reply.send(formatSuccess(await teamService.getRevenueSplits(id, userId)));
    })
  );

  // PUT /api/v1/teams/:id/splits - replace the revenue split configuration
  app.put(
    '/api/v1/teams/:id/splits',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = SetRevenueSplitsSchema.parse(request.body);
      reply.send(formatSuccess(await teamService.setRevenueSplits(userId, id, body)));
    })
  );

  // GET /api/v1/teams/:id/contributions - contribution history
  app.get(
    '/api/v1/teams/:id/contributions',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const query = ContributionQuerySchema.parse(request.query);
      reply.send(formatSuccess(await teamService.listContributions(id, userId, query)));
    })
  );

  // POST /api/v1/teams/:id/contributions - record a contribution
  app.post(
    '/api/v1/teams/:id/contributions',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = RecordContributionSchema.parse(request.body);
      reply.code(201).send(formatSuccess(await teamService.recordContribution(userId, id, body)));
    })
  );

  // POST /api/v1/teams/:id/revenue/distribute - split revenue across the team
  app.post(
    '/api/v1/teams/:id/revenue/distribute',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = DistributeRevenueSchema.parse(request.body);
      reply.code(201).send(formatSuccess(await teamService.distributeRevenue(userId, id, body)));
    })
  );

  // GET /api/v1/teams/:id/dashboard - collective team stats
  app.get(
    '/api/v1/teams/:id/dashboard',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      reply.send(formatSuccess(await teamService.getTeamDashboard(id, userId)));
    })
  );

  // PUT /api/v1/teams/:id/payout-account - set the shared payout wallet
  app.put(
    '/api/v1/teams/:id/payout-account',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = SetPayoutAccountSchema.parse(request.body);
      reply.send(formatSuccess(await teamService.setPayoutAccount(userId, id, body)));
    })
  );

  // GET /api/v1/teams/:id/payouts - team payout history
  app.get(
    '/api/v1/teams/:id/payouts',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const query = PayoutQuerySchema.parse(request.query);
      reply.send(formatSuccess(await teamService.listTeamPayouts(id, userId, query)));
    })
  );

  // POST /api/v1/teams/:id/payouts - request a payout from the team balance
  app.post(
    '/api/v1/teams/:id/payouts',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = RequestTeamPayoutSchema.parse(request.body);
      reply.code(201).send(formatSuccess(await teamService.requestTeamPayout(userId, id, body)));
    })
  );

  // PATCH /api/v1/teams/:id/payouts/:payoutId - advance a payout's status
  app.patch(
    '/api/v1/teams/:id/payouts/:payoutId',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id, payoutId } = request.params as { id: string; payoutId: string };
      const body = UpdateTeamPayoutStatusSchema.parse(request.body);
      reply.send(formatSuccess(await teamService.updateTeamPayoutStatus(userId, id, payoutId, body)));
    })
  );

  // GET /api/v1/teams/:id/audit-logs - team member change history
  app.get(
    '/api/v1/teams/:id/audit-logs',
    auth,
    withErrorHandling(async (request, reply) => {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const query = AuditQuerySchema.parse(request.query);
      reply.send(formatSuccess(await teamService.listAuditLogs(id, userId, query)));
    })
  );
};
