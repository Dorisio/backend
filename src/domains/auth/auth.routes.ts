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
        const payload = verifyToken(token);
        const expiresAt = new Date((payload as Record<string, number>).exp * 1000);
        await blacklistToken(token, expiresAt);
      }
      reply.send(formatSuccess({ message: 'Logged out successfully' }));
    }
  );
};
