import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ReferralService } from './referral.service';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { AppError, ValidationError } from '../../utils/errors';
import { CreateTierRequest, UpdateTierRequest } from './referral.types';

export const registerReferralRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const referralService = new ReferralService(prisma);

  // ── Affiliate: Get or create your referral code ──────────────────────────
  // GET /api/v1/referrals/my-code
  app.get(
    '/api/v1/referrals/my-code',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Get (or lazily create) the authenticated user\'s referral code',
        response: {
          200: { description: 'Referral code' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const code = await referralService.getOrCreateReferralCode(user.userId);
        reply.send(formatSuccess(code));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Affiliate: Dashboard ──────────────────────────────────────────────────
  // GET /api/v1/referrals/dashboard
  app.get(
    '/api/v1/referrals/dashboard',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Get the affiliate dashboard for the authenticated user',
        response: {
          200: { description: 'Dashboard stats, recent referrals and commissions' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const dashboard = await referralService.getAffiliateDashboard(user.userId);
        reply.send(formatSuccess(dashboard));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Affiliate: Request commission payout ──────────────────────────────────
  // POST /api/v1/referrals/payout
  app.post(
    '/api/v1/referrals/payout',
    {
      preHandler: authMiddleware,
      schema: {
        description: 'Mark all pending commissions as paid',
        response: {
          200: { description: 'Payout result' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user!;
        const result = await referralService.payoutCommissions(user.userId);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Public: Look up a referral code (used on the sign-up form) ────────────
  // GET /api/v1/referrals/code/:code
  app.get<{ Params: { code: string } }>(
    '/api/v1/referrals/code/:code',
    {
      schema: {
        description: 'Validate a referral code (public; used during sign-up)',
        params: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
        response: {
          200: { description: 'Referral code metadata' },
          404: { description: 'Code not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { code: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { code } = request.params;
        const record = await referralService.getReferralCodeByValue(code.toUpperCase());
        // Return limited info to the public
        reply.send(
          formatSuccess({
            code: record.code,
            isActive: record.isActive,
          })
        );
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: List all tiers ─────────────────────────────────────────────────
  // GET /api/v1/admin/referrals/tiers
  app.get(
    '/api/v1/admin/referrals/tiers',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'List all referral commission tiers (admin)',
        response: {
          200: { description: 'Tier list' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const tiers = await referralService.listTiers();
        reply.send(formatSuccess(tiers));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Create tier ────────────────────────────────────────────────────
  // POST /api/v1/admin/referrals/tiers
  app.post<{ Body: CreateTierRequest }>(
    '/api/v1/admin/referrals/tiers',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Create a new referral commission tier (admin)',
        body: {
          type: 'object',
          required: ['name', 'commissionRate'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            commissionRate: { type: 'number', minimum: 0, maximum: 1 },
            isDefault: { type: 'boolean' },
          },
        },
        response: {
          201: { description: 'Created tier' },
          400: { description: 'Validation error' },
          409: { description: 'Name conflict' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: CreateTierRequest }>,
      reply: FastifyReply
    ) => {
      try {
        const tier = await referralService.createTier(request.body);
        reply.code(201).send(formatSuccess(tier));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Update tier ────────────────────────────────────────────────────
  // PATCH /api/v1/admin/referrals/tiers/:tierId
  app.patch<{ Params: { tierId: string }; Body: UpdateTierRequest }>(
    '/api/v1/admin/referrals/tiers/:tierId',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Update a referral commission tier (admin)',
        params: {
          type: 'object',
          properties: { tierId: { type: 'string' } },
          required: ['tierId'],
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            commissionRate: { type: 'number', minimum: 0, maximum: 1 },
            isDefault: { type: 'boolean' },
          },
        },
        response: {
          200: { description: 'Updated tier' },
          404: { description: 'Tier not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { tierId: string }; Body: UpdateTierRequest }>,
      reply: FastifyReply
    ) => {
      try {
        const { tierId } = request.params;
        const tier = await referralService.updateTier(tierId, request.body);
        reply.send(formatSuccess(tier));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Delete tier ────────────────────────────────────────────────────
  // DELETE /api/v1/admin/referrals/tiers/:tierId
  app.delete<{ Params: { tierId: string } }>(
    '/api/v1/admin/referrals/tiers/:tierId',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Delete a referral commission tier (admin)',
        params: {
          type: 'object',
          properties: { tierId: { type: 'string' } },
          required: ['tierId'],
        },
        response: {
          200: { description: 'Deleted' },
          400: { description: 'Cannot delete default tier' },
          404: { description: 'Tier not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { tierId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { tierId } = request.params;
        await referralService.deleteTier(tierId);
        reply.send(formatSuccess({ deleted: true }));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Lock a referral code ───────────────────────────────────────────
  // POST /api/v1/admin/referrals/codes/:codeId/lock
  app.post<{ Params: { codeId: string }; Body: { reason: string } }>(
    '/api/v1/admin/referrals/codes/:codeId/lock',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Lock a referral code (admin fraud control)',
        params: {
          type: 'object',
          properties: { codeId: { type: 'string' } },
          required: ['codeId'],
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string' },
          },
        },
        response: {
          200: { description: 'Locked code' },
          404: { description: 'Code not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { codeId: string }; Body: { reason: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { codeId } = request.params;
        const { reason } = request.body;
        if (!reason?.trim()) {
          throw new ValidationError('Lock reason is required');
        }
        const result = await referralService.lockReferralCode(codeId, reason);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Flag a referral as fraud ──────────────────────────────────────
  // POST /api/v1/admin/referrals/:referralId/flag-fraud
  app.post<{ Params: { referralId: string }; Body: { reason: string } }>(
    '/api/v1/admin/referrals/:referralId/flag-fraud',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Flag a referral as fraudulent (admin)',
        params: {
          type: 'object',
          properties: { referralId: { type: 'string' } },
          required: ['referralId'],
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string' },
          },
        },
        response: {
          200: { description: 'Fraud flagged' },
          404: { description: 'Referral not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { referralId: string }; Body: { reason: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { referralId } = request.params;
        const { reason } = request.body;
        if (!reason?.trim()) {
          throw new ValidationError('Fraud reason is required');
        }
        await referralService.flagReferralAsFraud(referralId, reason);
        reply.send(formatSuccess({ flagged: true }));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // ── Admin: Assign tier to a referral code ─────────────────────────────────
  // POST /api/v1/admin/referrals/codes/:codeId/tier
  app.post<{ Params: { codeId: string }; Body: { tierId: string } }>(
    '/api/v1/admin/referrals/codes/:codeId/tier',
    {
      preHandler: requireAdmin,
      schema: {
        description: 'Assign a commission tier to a referral code (admin)',
        params: {
          type: 'object',
          properties: { codeId: { type: 'string' } },
          required: ['codeId'],
        },
        body: {
          type: 'object',
          required: ['tierId'],
          properties: {
            tierId: { type: 'string' },
          },
        },
        response: {
          200: { description: 'Updated referral code' },
          404: { description: 'Code or tier not found' },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { codeId: string }; Body: { tierId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { codeId } = request.params;
        const { tierId } = request.body;
        const result = await referralService.assignTierToCode(codeId, tierId);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );
};
