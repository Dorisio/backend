import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { formatSuccess } from '../../types/response';
import { TwoFactorService } from './two-factor.service';
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$|^[a-f0-9]{12}$/i), deviceToken: z.string().min(16).max(256).optional() });
export const registerTwoFactorRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const service = new TwoFactorService(prisma);
  app.post('/api/v1/auth/2fa/setup', { preHandler: authMiddleware }, async (request) => formatSuccess(await service.setup(request.user!.userId)));
  app.post('/api/v1/auth/2fa/enable', { preHandler: authMiddleware }, async (request) => formatSuccess(await service.enable(request.user!.userId, codeSchema.parse(request.body).code)));
  app.post('/api/v1/auth/2fa/verify', { preHandler: authMiddleware }, async (request) => { const body = codeSchema.parse(request.body); return formatSuccess(await service.verify(request.user!.userId, body.code, body.deviceToken)); });
  app.post('/api/v1/auth/2fa/disable', { preHandler: authMiddleware }, async (request) => formatSuccess(await service.disable(request.user!.userId, codeSchema.parse(request.body).code)));
};
