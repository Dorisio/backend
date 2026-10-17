import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AdminService, FlagWalletRequest, FreezeAccountRequest } from './admin.service';
import { DisputeService, ResolveDisputeInput } from './dispute.service';
import { PaymentStatus } from '../../lib/payments/types';
import { formatSuccess, formatError } from '../../types/response';
import { requireAdmin } from '../../middleware/rbac';
import { AppError, UnauthorizedError, ValidationError } from '../../utils/errors';
import cache, { getStats, resetStats } from '../../lib/cache/index';
import { CacheWarmer } from '../../lib/cache/cache-warming';
import { ReconciliationService } from './reconciliation.service';

export const registerAdminRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const adminService = new AdminService(prisma);
  const disputeService = new DisputeService(prisma);

  app.post<{ Body: { creatorIds: string[] } }>(
    '/api/v1/admin/batches/creators/verify',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const result = await adminService.bulkVerifyCreators(
          request.user?.userId ?? '',
          request.body.creatorIds
        );
        return reply.code(202).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof AppError)
          return reply.code(error.statusCode).send(formatError(error.message, error.code));
        throw error;
      }
    }
  );

  // POST /api/v1/admin/wallets/:address/flag - Flag wallet
  app.post<{ Params: { address: string }; Body: FlagWalletRequest }>(
    '/api/v1/admin/wallets/:address/flag',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Wallet address' },
          },
        },
        body: {
          type: 'object',
          required: ['reason', 'severity'],
          properties: {
            reason: { type: 'string', description: 'Reason for flagging' },
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            notes: { type: 'string', description: 'Additional notes' },
          },
        },
        response: {
          201: { type: 'null', description: 'Wallet flagged' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { address } = request.params as { address: string };
        const body = request.body as FlagWalletRequest;
        const result = await adminService.flagWallet(user.userId, address, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/wallets/flags/:flagId/resolve - Unflag wallet
  app.post<{ Params: { flagId: string } }>(
    '/api/v1/admin/wallets/flags/:flagId/resolve',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          properties: {
            flagId: { type: 'string', description: 'Flag ID' },
          },
        },
        response: {
          200: { type: 'null', description: 'Flag resolved' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { flagId } = request.params as { flagId: string };
        await adminService.unflagWallet(user.userId, flagId);
        reply.send(formatSuccess({ message: 'Flag resolved' }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/creators/:creatorId/freeze - Freeze account
  app.post<{ Params: { creatorId: string }; Body: FreezeAccountRequest }>(
    '/api/v1/admin/creators/:creatorId/freeze',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          properties: {
            creatorId: { type: 'string', description: 'Creator ID' },
          },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', description: 'Reason for freeze' },
            duration: { type: 'number', description: 'Duration in hours (null = indefinite)' },
            notes: { type: 'string', description: 'Additional notes' },
          },
        },
        response: {
          201: { type: 'null', description: 'Account frozen' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { creatorId } = request.params as { creatorId: string };
        const body = request.body as FreezeAccountRequest;
        const result = await adminService.freezeAccount(user.userId, creatorId, body);
        reply.code(201).send(formatSuccess(result));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/creators/freezes/:freezeId/resolve - Unfreeze account
  app.post<{ Params: { freezeId: string } }>(
    '/api/v1/admin/creators/freezes/:freezeId/resolve',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          properties: {
            freezeId: { type: 'string', description: 'Freeze ID' },
          },
        },
        response: {
          200: { type: 'null', description: 'Account unfrozen' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { freezeId } = request.params as { freezeId: string };
        await adminService.unfreezeAccount(user.userId, freezeId);
        reply.send(formatSuccess({ message: 'Account unfrozen' }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/admin/moderation - Moderation queue
  app.get(
    '/api/v1/admin/moderation',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: { type: 'null', description: 'Moderation queue' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const query = request.query as { page?: string; pageSize?: string; limit?: string };
        const page = query?.page ? parseInt(query.page) : 1;
        const pageSize = query?.pageSize
          ? parseInt(query.pageSize)
          : query?.limit
            ? parseInt(query.limit)
            : 20;

        const result = await adminService.getModerationQueue(page, pageSize);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/admin/cache/stats - Get cache statistics
  app.get(
    '/api/v1/admin/cache/stats',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: { type: 'null', description: 'Cache statistics' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const stats = getStats();
        reply.send(formatSuccess(stats));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/cache/clear - Clear entire cache
  app.post(
    '/api/v1/admin/cache/clear',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: { type: 'null', description: 'Cache cleared' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        await cache.clear();
        reply.send(formatSuccess({ message: 'Cache cleared successfully' }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/cache/invalidate - Invalidate specific cache key
  app.post<{ Body: { key: string } }>(
    '/api/v1/admin/cache/invalidate',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', description: 'Cache key to invalidate' },
          },
        },
        response: {
          200: { type: 'null', description: 'Cache key invalidated' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { key } = request.body as { key: string };
        await cache.del(key);
        reply.send(formatSuccess({ message: `Cache key '${key}' invalidated` }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/cache/warm - Trigger cache warming
  app.post<{ Body: { type?: string } }>(
    '/api/v1/admin/cache/warm',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['creators', 'trending', 'analytics', 'all'],
              description: 'Type of cache warming',
            },
          },
        },
        response: {
          200: { type: 'null', description: 'Cache warming triggered' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const { type = 'all' } = request.body as { type?: string };
        const warmer = new CacheWarmer(prisma);

        switch (type) {
          case 'creators':
            await warmer.warmTopCreators();
            break;
          case 'trending':
            await warmer.warmTrendingData();
            break;
          case 'analytics':
            await warmer.warmAnalyticsData();
            break;
          case 'all':
          default:
            await warmer.warmAll();
            break;
        }

        reply.send(formatSuccess({ message: `Cache warming completed for '${type}'` }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // POST /api/v1/admin/cache/reset-stats - Reset cache statistics
  app.post(
    '/api/v1/admin/cache/reset-stats',
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: { type: 'null', description: 'Cache statistics reset' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        resetStats();
        reply.send(formatSuccess({ message: 'Cache statistics reset successfully' }));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );

  // Helper to register dispute routes on both /api/admin and /api/v1/admin
  const registerDisputeRoutes = (prefix: string) => {
    // POST :prefix/payments/:id/dispute - Mark payment as disputed
    app.post<{ Params: { id: string }; Body: { reason: string; notes?: string } }>(
      `${prefix}/payments/:id/dispute`,
      {
        preHandler: requireAdmin,
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', description: 'Payment ID' } },
          },
          body: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: { type: 'string', description: 'Reason for dispute' },
              notes: { type: 'string', description: 'Optional internal notes' },
            },
          },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const user = request.user;
          if (!user) throw new UnauthorizedError('User not found');

          const { id } = request.params as { id: string };
          const body = request.body as { reason: string; notes?: string };
          const result = await disputeService.markDisputed(id, user.userId, body);
          return reply.code(200).send(formatSuccess(result));
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            return reply.code(403).send(formatError(error.message, error.code));
          } else if (error instanceof AppError) {
            return reply.code(error.statusCode).send(formatError(error.message, error.code));
          } else {
            throw error;
          }
        }
      }
    );

    // POST :prefix/payments/:id/resolve - Resolve payment dispute (approve, reject, refund)
    app.post<{
      Params: { id: string };
      Body: {
        action: 'approve' | 'reject' | 'refund';
        reason: string;
        notes?: string;
        amount?: number;
        targetStatus?: PaymentStatus;
      };
    }>(
      `${prefix}/payments/:id/resolve`,
      {
        preHandler: requireAdmin,
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', description: 'Payment ID' } },
          },
          body: {
            type: 'object',
            required: ['action', 'reason'],
            properties: {
              action: { type: 'string', enum: ['approve', 'reject', 'refund'] },
              reason: { type: 'string', description: 'Resolution reason' },
              notes: { type: 'string', description: 'Optional internal notes' },
              amount: { type: 'number', description: 'Optional refund amount' },
              targetStatus: { type: 'string', description: 'Optional explicit target status' },
            },
          },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const user = request.user;
          if (!user) throw new UnauthorizedError('User not found');

          const { id } = request.params as { id: string };
          const body = request.body as ResolveDisputeInput;
          const result = await disputeService.resolveDispute(id, user.userId, body);
          return reply.code(200).send(formatSuccess(result));
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            return reply.code(403).send(formatError(error.message, error.code));
          } else if (error instanceof AppError) {
            return reply.code(error.statusCode).send(formatError(error.message, error.code));
          } else {
            throw error;
          }
        }
      }
    );

    // GET :prefix/payments - List payments with status filter (e.g. status='disputed')
    app.get<{
      Querystring: {
        status?: string;
        page?: string;
        pageSize?: string;
        limit?: string;
        userId?: string;
        creatorId?: string;
      };
    }>(
      `${prefix}/payments`,
      {
        preHandler: requireAdmin,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const user = request.user;
          if (!user) throw new UnauthorizedError('User not found');

          const query = request.query as {
            status?: string;
            page?: string;
            pageSize?: string;
            limit?: string;
            userId?: string;
            creatorId?: string;
          };
          const page = query?.page ? parseInt(query.page, 10) : 1;
          const pageSize = query?.pageSize
            ? parseInt(query.pageSize, 10)
            : query?.limit
              ? parseInt(query.limit, 10)
              : 20;

          const result = await disputeService.listPayments({
            status: query?.status,
            page,
            pageSize,
            userId: query?.userId,
            creatorId: query?.creatorId,
          });
          return reply.send(formatSuccess(result));
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            return reply.code(403).send(formatError(error.message, error.code));
          } else if (error instanceof AppError) {
            return reply.code(error.statusCode).send(formatError(error.message, error.code));
          } else {
            throw error;
          }
        }
      }
    );

    // GET :prefix/payments/:id - Get single payment detail
    app.get<{ Params: { id: string } }>(
      `${prefix}/payments/:id`,
      {
        preHandler: requireAdmin,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const user = request.user;
          if (!user) throw new UnauthorizedError('User not found');

          const { id } = request.params as { id: string };
          const result = await disputeService.getPayment(id);
          return reply.send(formatSuccess(result));
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            return reply.code(403).send(formatError(error.message, error.code));
          } else if (error instanceof AppError) {
            return reply.code(error.statusCode).send(formatError(error.message, error.code));
          } else {
            throw error;
          }
        }
      }
    );
  };

  registerDisputeRoutes('/api/admin');
  registerDisputeRoutes('/api/v1/admin');

  registerReconciliationRoutes('/api/admin');
  registerReconciliationRoutes('/api/v1/admin');
};

type ReconciliationQuery = { from?: string; to?: string; format?: 'json' | 'csv' };

function reconciliationPeriod(query: ReconciliationQuery): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new ValidationError('from and to must be valid dates with from before to');
  }
  return { from, to };
}

const registerReconciliationRoutes = (prefix: string) => {
  app.get<{ Querystring: ReconciliationQuery }>(
    `${prefix}/payments/reconciliation`,
    {
      preHandler: requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Start of period (ISO-8601)' },
            to: { type: 'string', description: 'End of period (ISO-8601)' },
            format: { type: 'string', enum: ['json', 'csv'], description: 'Response format' },
          },
        },
        response: {
          200: { type: 'null', description: 'Reconciliation report' },
          400: { type: 'null', description: 'Invalid period' },
          401: { type: 'null', description: 'Unauthorized' },
          403: { type: 'null', description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new UnauthorizedError('User not found');

        const range = reconciliationPeriod(request.query as ReconciliationQuery);
        const reconciliationService = new ReconciliationService(prisma);
        const report = await reconciliationService.getReconciliationReport(user.userId, range);

        if (request.query.format === 'csv') {
          const csv = await reconciliationService.toCsv(report);
          return reply
            .type('text/csv; charset=utf-8')
            .header('Content-Disposition', 'attachment; filename="reconciliation-report.csv"')
            .send(csv);
        }
        return reply.send(formatSuccess(report));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          return reply.code(403).send(formatError(error.message, error.code));
        } else if (error instanceof ValidationError) {
          return reply.code(400).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          return reply.code(error.statusCode).send(formatError(error.message, error.code));
        }
        throw error;
      }
    }
  );
};
