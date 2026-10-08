import { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { UserService } from './user.service';
import {
  ChangePasswordSchema,
  UpdateAvatarRequestSchema,
  UpdateUserProfileSchema,
  UpdateUserSettingsSchema,
} from './user.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { AppError, UnauthorizedError, ValidationError } from '../../utils/errors';
import { AVATAR_BODY_LIMIT_BYTES } from './avatar.storage';

export const registerUserRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const userService = new UserService(prisma);

  const requestContext = (request: FastifyRequest) => ({
    ip: request.ip ?? null,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  /**
   * Normalizes anything a route throws into the standard error envelope.
   * Unknown errors are re-thrown for the global error handler.
   */
  const sendError = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof ZodError) {
      reply.code(400).send(
        formatError('The request data is invalid', 'VALIDATION_ERROR', {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        })
      );
      return;
    }
    if (error instanceof AppError) {
      reply.code(error.statusCode).send(formatError(error.message, error.code, error.details));
      return;
    }
    throw error;
  };

  const loadUserId = (request: FastifyRequest): string => {
    const user = request.user;
    if (!user) {
      throw new UnauthorizedError('User not found in request');
    }
    return user.userId;
  };

  // GET /api/v1/users/profile - Get user profile
  app.get(
    '/api/v1/users/profile',
    {
      preHandler: authMiddleware,
      schema: {
        response: {
          200: { description: 'User profile' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await userService.getUserProfile(loadUserId(request));
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // PATCH / PUT /api/v1/users/profile - Partially update the user profile.
  // Email is deliberately not updatable here (#49).
  const updateProfileHandler: RouteHandlerMethod = async (request, reply) => {
    try {
      const userId = loadUserId(request);

      // Reject any attempt to change the login email before schema parsing
      // silently drops the field.
      if (
        request.body !== null &&
        typeof request.body === 'object' &&
        Object.prototype.hasOwnProperty.call(request.body, 'email')
      ) {
        throw new ValidationError(
          'Email cannot be changed here; use the email verification flow'
        );
      }

      const body = UpdateUserProfileSchema.parse(request.body);
      const result = await userService.updateUserProfile(userId, body, requestContext(request));
      reply.send(formatSuccess(result));
    } catch (error) {
      sendError(reply, error);
    }
  };

  const updateProfileOptions = {
    preHandler: authMiddleware,
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name' },
          bio: { type: 'string', description: 'User bio' },
        },
      },
      response: {
        200: { description: 'Profile updated' },
        400: { description: 'Validation error' },
        401: { description: 'Unauthorized' },
      },
    },
  };

  app.patch('/api/v1/users/profile', updateProfileOptions, updateProfileHandler);
  app.put('/api/v1/users/profile', updateProfileOptions, updateProfileHandler);

  // POST /api/v1/users/password - Change password (requires the current one)
  app.post<{ Body: unknown }>(
    '/api/v1/users/password',
    {
      preHandler: authMiddleware,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', description: 'Current password' },
            newPassword: {
              type: 'string',
              minLength: 8,
              description: 'New password (min 8 chars)',
            },
          },
        },
        response: {
          200: { description: 'Password updated' },
          400: { description: 'Validation error or incorrect current password' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = loadUserId(request);
        const body = ChangePasswordSchema.parse(request.body);

        const authHeader = request.headers.authorization;
        const accessToken = authHeader?.startsWith('Bearer ')
          ? authHeader.substring(7)
          : undefined;

        const result = await userService.changePassword(
          userId,
          body,
          requestContext(request),
          accessToken
        );
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // PUT /api/v1/users/avatar - Upload a profile photo as a base64 data URL
  app.put<{ Body: unknown }>(
    '/api/v1/users/avatar',
    {
      preHandler: authMiddleware,
      // A 5MB image becomes ~6.7MB as base64, above Fastify's 1MB default.
      bodyLimit: AVATAR_BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['image'],
          properties: {
            image: {
              type: 'string',
              description: 'Base64 data URL (image/jpeg or image/png, up to 5MB)',
            },
          },
        },
        response: {
          200: { description: 'Avatar updated' },
          400: { description: 'Invalid image type or size' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = loadUserId(request);
        const body = UpdateAvatarRequestSchema.parse(request.body);
        const result = await userService.updateAvatar(
          userId,
          body.image,
          requestContext(request)
        );
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // GET /api/v1/users/profile/history - Audit trail of profile changes
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    '/api/v1/users/profile/history',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = loadUserId(request);
        const query = request.query ?? {};
        const page = query.page ? parseInt(query.page, 10) : 1;
        const pageSize = query.pageSize ? parseInt(query.pageSize, 10) : 20;

        const result = await userService.getProfileChanges(userId, page, pageSize);
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // GET /api/v1/users/settings - Get user settings
  app.get(
    '/api/v1/users/settings',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const result = await userService.getUserSettings(loadUserId(request));
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // PATCH /api/v1/users/settings - Update user settings
  app.patch<{ Body: unknown }>(
    '/api/v1/users/settings',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = loadUserId(request);
        const body = UpdateUserSettingsSchema.parse(request.body);
        const result = await userService.updateUserSettings(userId, body, requestContext(request));
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );

  // GET /api/v1/users/transaction-history - Get user transaction history
  app.get<{ Querystring: { page?: string; pageSize?: string; limit?: string } }>(
    '/api/v1/users/transaction-history',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = loadUserId(request);
        const query = request.query as { page?: string; pageSize?: string; limit?: string };
        const page = query.page ? parseInt(query.page, 10) : 1;
        const pageSize = query.pageSize
          ? parseInt(query.pageSize, 10)
          : query.limit
            ? parseInt(query.limit, 10)
            : 20;

        const result = await userService.getUserTransactionHistory(userId, page, pageSize);
        reply.send(formatSuccess(result));
      } catch (error) {
        sendError(reply, error);
      }
    }
  );
};
