import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';
import {
  RegisterRequestSchema,
  LoginRequestSchema,
  RegisterRequest,
  LoginRequest,
} from './auth.types';
import { formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { blacklistToken } from '../../utils/token-blacklist';
import { verifyToken } from '../../utils/jwt';
import { config } from '../../config/env';

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
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RegisterRequestSchema.parse(request.body);
      const result = await authService.register(body);
      reply.code(201).send(formatSuccess(result));
    }
  );

  app.post<{ Body: LoginRequest }>(
    '/api/v1/auth/login',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = LoginRequestSchema.parse(request.body);
      const result = await authService.login(body);
      reply.send(formatSuccess(result));
    }
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: authMiddleware },
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
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        verifyToken(token); // Verify token is valid
        const expiryMs = parseExpiryToMs(config.JWT_EXPIRES_IN);
        const expiresAt = new Date(Date.now() + expiryMs);
        await blacklistToken(token, expiresAt);
      }
      reply.send(formatSuccess({ message: 'Logged out successfully' }));
    }
  );
};
