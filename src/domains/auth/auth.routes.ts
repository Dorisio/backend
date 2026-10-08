import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RefreshTokenRequestSchema,
  PasswordResetRequestSchema,
  PasswordResetConfirmRequestSchema,
  RegisterRequest,
  LoginRequest,
  RefreshTokenRequest,
  PasswordResetRequest,
  PasswordResetConfirmRequest,
} from './auth.types';
import { formatSuccess, formatError } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { blacklistToken } from '../../utils/token-blacklist';
import { verifyToken } from '../../utils/jwt';
import { config } from '../../config/env';
import { z } from 'zod';
import { ValidationError } from '../../utils/errors';
import { SessionService } from './session.service';

const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

const ResendVerificationSchema = z.object({
  email: z.string().email('Invalid email format'),
});

/**
 * Parse expiry string like "7d", "24h", "3600" to milliseconds
 */
function parseExpiryToMs(expiryStr: string): number {
  const match = expiryStr.match(/^(\d+)([dhms]?)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 's':
      return value * 1000;
    default:
      return value * 1000;
  }
}

export const registerAuthRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const authService = new AuthService(prisma);

  app.post<{ Body: RegisterRequest }>(
    '/api/v1/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', description: 'User email' },
            password: { type: 'string', minLength: 8, description: 'Password (min 8 chars)' },
            name: { type: 'string', description: 'User display name' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
          },
          400: { description: 'Validation error or user already exists' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RegisterRequestSchema.parse(request.body);
      const result = await authService.register(body);
      reply.code(201).send(formatSuccess(result));
    }
  );

  app.post<{ Body: LoginRequest }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', description: 'User email' },
            password: { type: 'string', description: 'User password' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string', description: 'JWT access token' },
                  refreshToken: { type: 'string', description: 'JWT refresh token' },
                  user: { type: 'object' },
                },
              },
            },
          },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = LoginRequestSchema.parse(request.body);
      const result = await authService.login(body, {
        ipAddress: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        device: typeof request.headers['sec-ch-ua-platform'] === 'string' ? request.headers['sec-ch-ua-platform'] : undefined,
      });
      
      // Set refresh token as httpOnly cookie
      (reply as any).setCookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: parseExpiryToMs(config.JWT_REFRESH_EXPIRES_IN) / 1000,
      });

      reply.send(formatSuccess({
        ...result,
        refreshToken: undefined, // Don't send refresh token in body, it's in cookie
      }));
    }
  );

  app.post<{ Body: RefreshTokenRequest }>(
    '/api/v1/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string', description: 'Refresh token' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string', description: 'New JWT access token' },
                  refreshToken: { type: 'string', description: 'New JWT refresh token' },
                },
              },
            },
          },
          401: { description: 'Invalid or revoked refresh token' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RefreshTokenRequestSchema.parse(request.body);
      const result = await authService.refreshAccessToken(body.refreshToken);
      
      // Set new refresh token as httpOnly cookie
      (reply as any).setCookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: parseExpiryToMs(config.JWT_REFRESH_EXPIRES_IN) / 1000,
      });

      reply.send(formatSuccess({
        ...result,
        refreshToken: undefined, // Don't send refresh token in body, it's in cookie
      }));
    }
  );

  app.post<{ Body: PasswordResetRequest }>(
    '/api/v1/auth/password-reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        response: { 200: { description: 'Reset instructions are sent when the account exists' } },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = PasswordResetRequestSchema.parse(request.body);
      const result = await authService.requestPasswordReset(body.email);
      reply.send(formatSuccess(result));
    }
  );

  app.post<{ Body: PasswordResetConfirmRequest }>(
    '/api/v1/auth/password-reset/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string', minLength: 1 },
            newPassword: {
              type: 'string',
              minLength: 8,
              description: 'At least 8 characters with uppercase, lowercase, and number',
            },
          },
        },
        response: {
          200: { description: 'Password reset completed' },
          400: { description: 'Invalid, expired, or already used token' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = PasswordResetConfirmRequestSchema.parse(request.body);
      const result = await authService.confirmPasswordReset(body.token, body.newPassword);
      (reply as any).clearCookie('refreshToken', { path: '/' });
      reply.send(formatSuccess(result));
    }
  );

  app.get(
    '/api/v1/auth/me',
    {
      preHandler: authMiddleware,
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                },
              },
            },
          },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        throw new Error('User not found in request');
      }
      reply.send(
        formatSuccess({
          id: user.userId,
          email: user.email,
          role: user.role,
        })
      );
    }
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: authMiddleware,
      schema: {
        response: {
          200: { description: 'Logout successful' },
          401: { description: 'Unauthorized' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        verifyToken(token); // Verify token is valid
        const expiryMs = parseExpiryToMs(config.JWT_EXPIRES_IN);
        const expiresAt = new Date(Date.now() + expiryMs);
        await blacklistToken(token, expiresAt);
      }

      // Clear refresh token cookie
      (reply as any).clearCookie('refreshToken', {
        path: '/',
      });

      reply.send(formatSuccess({ message: 'Logged out successfully' }));
    }
  );

  app.get('/api/v1/auth/sessions', { preHandler: authMiddleware }, async (request, reply) => {
    reply.send(formatSuccess(await new SessionService(prisma).list(request.user!.userId)));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/auth/sessions/:id', { preHandler: authMiddleware }, async (request, reply) => {
    await new SessionService(prisma).revoke(request.user!.userId, request.params.id);
    reply.send(formatSuccess({ message: 'Session revoked' }));
  });

  app.post('/api/v1/auth/sessions/revoke-all', { preHandler: authMiddleware }, async (request, reply) => {
    await new SessionService(prisma).revokeAll(request.user!.userId);
    reply.send(formatSuccess({ message: 'All sessions revoked' }));
  });

  // POST /api/v1/auth/verify-email - Verify email with token
  app.post<{ Body: { token: string } }>(
    '/api/v1/auth/verify-email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', description: 'Verification token from email' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                },
              },
            },
          },
          400: { description: 'Invalid or expired token' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = VerifyEmailSchema.parse(request.body);
        const result = await authService.verifyEmail(body.token);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          reply.code(400).send(formatError('Verification failed', 'VERIFICATION_ERROR'));
        }
      }
    }
  );

  // POST /api/v1/auth/resend-verification - Resend verification email
  app.post<{ Body: { email: string } }>(
    '/api/v1/auth/resend-verification',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', description: 'User email' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  message: { type: 'string' },
                },
              },
            },
          },
          400: { description: 'Invalid email or already verified' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = ResendVerificationSchema.parse(request.body);
        const result = await authService.resendVerificationEmail(body.email);
        reply.send(formatSuccess(result));
      } catch (error) {
        if (error instanceof ValidationError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          reply.code(400).send(formatError('Failed to resend verification email', 'RESEND_ERROR'));
        }
      }
    }
  );
};
