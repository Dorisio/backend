import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { UserService } from './user.service';
import { UpdateUserProfileSchema, UpdateUserSettingsSchema } from './user.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ValidationError, AppError } from '../../utils/errors';

export const registerUserRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const userService = new UserService(prisma);

  // GET /api/v1/users/profile - Get user profile
  app.get(
    '/api/v1/users/profile',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const result = await userService.getUserProfile(user.userId);
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

  // PATCH /api/v1/users/profile - Update user profile
  app.patch<{ Body: any }>(
    '/api/v1/users/profile',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const body = UpdateUserProfileSchema.parse(request.body);
        const result = await userService.updateUserProfile(user.userId, body);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply
            .code(400)
            .send(
              formatError((error as any).message || 'Invalid request body', 'VALIDATION_ERROR')
            );
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/users/settings - Get user settings
  app.get(
    '/api/v1/users/settings',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const result = await userService.getUserSettings(user.userId);
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

  // PATCH /api/v1/users/settings - Update user settings
  app.patch<{ Body: any }>(
    '/api/v1/users/settings',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const body = UpdateUserSettingsSchema.parse(request.body);
        const result = await userService.updateUserSettings(user.userId, body);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else if (error instanceof Error && error.message.includes('validation')) {
          reply
            .code(400)
            .send(
              formatError((error as any).message || 'Invalid request body', 'VALIDATION_ERROR')
            );
        } else {
          throw error;
        }
      }
    }
  );

  // GET /api/v1/users/transaction-history - Get user transaction history
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    '/api/v1/users/transaction-history',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = request.user;

        if (!user) {
          throw new Error('User not found in request');
        }

        const page = request.query.page ? parseInt(request.query.page) : 1;
        const pageSize = request.query.pageSize ? parseInt(request.query.pageSize) : 10;

        const result = await userService.getUserTransactionHistory(user.userId, page, pageSize);
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
