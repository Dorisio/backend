import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { formatSuccess } from '../../types/response';
import { AssetService } from './asset.service';

const assetSchema = z.object({ code: z.string().min(1).max(12), issuer: z.string().nullable().optional(), name: z.string().min(1).max(100), decimals: z.number().int().min(0).max(7).optional(), enabled: z.boolean().optional(), priority: z.number().int().optional(), feeBps: z.number().int().min(0).max(10_000).optional() });

export function registerAssetRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const service = new AssetService(prisma);
  app.get('/api/v1/assets', async (_request, reply) => reply.send(formatSuccess(await service.listEnabled())));
  app.get('/api/v1/admin/assets', { preHandler: requireAdmin }, async (_request, reply) => reply.send(formatSuccess(await service.listAll())));
  app.post('/api/v1/admin/assets', { preHandler: requireAdmin }, async (request, reply) => reply.code(201).send(formatSuccess(await service.create(assetSchema.parse(request.body) as any))));
  app.patch<{ Params: { id: string } }>('/api/v1/admin/assets/:id', { preHandler: requireAdmin }, async (request, reply) => reply.send(formatSuccess(await service.update(request.params.id, assetSchema.partial().parse(request.body) as any))));
  app.put<{ Body: { assetId: string } }>('/api/v1/creators/me/default-asset', { preHandler: authMiddleware }, async (request, reply) => reply.send(formatSuccess(await service.setCreatorDefault(request.user!.userId, request.body.assetId))));
}
