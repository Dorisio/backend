import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AdminService, FlagWalletRequest, FreezeAccountRequest } from './admin.service';
import { formatSuccess, formatError } from '../../types/response';
import { requireAdmin } from '../../middleware/rbac';
import { ValidationError, AppError, UnauthorizedError } from '../../utils/errors';
import cache, { getStats, getHitRate, resetStats } from '../../lib/cache/index';
import { CacheWarmer } from '../../lib/cache/cache-warming';

export const registerAdminRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const adminService = new AdminService(prisma);

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
          201: { description: 'Wallet flagged' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Flag resolved' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          201: { description: 'Account frozen' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Account unfrozen' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Moderation queue' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;
        if (!user) throw new Error('User not found');

        const query = request.query as { page?: string; pageSize?: string; limit?: string };
        const page = query?.page ? parseInt(query.page) : 1;
        const pageSize = query?.pageSize ? parseInt(query.pageSize) : query?.limit ? parseInt(query.limit) : 20;

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
          200: { description: 'Cache statistics' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Cache cleared' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Cache key invalidated' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
            type: { type: 'string', enum: ['creators', 'trending', 'analytics', 'all'], description: 'Type of cache warming' },
          },
        },
        response: {
          200: { description: 'Cache warming triggered' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
          200: { description: 'Cache statistics reset' },
          401: { description: 'Unauthorized' },
          403: { description: 'Admin only' },
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
};
