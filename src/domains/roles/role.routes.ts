import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/rbac';
import { formatSuccess } from '../../types/response';
import { RoleService } from './role.service';
const roleSchema = z.object({ name: z.string(), description: z.string().optional(), hierarchy: z.number().int().min(0).max(100).optional() });
const permissionSchema = z.object({ name: z.string(), description: z.string().optional(), resource: z.string().min(1), action: z.string().min(1) });
export const registerRoleRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const service = new RoleService(prisma);
  void service.ensureDefaults();
  app.get('/api/v1/roles', { preHandler: requireAdmin }, async () => formatSuccess(await service.list()));
  app.post('/api/v1/roles', { preHandler: requireAdmin }, async (request) => formatSuccess(await service.create(request.user!.userId, roleSchema.parse(request.body))));
  app.post('/api/v1/permissions', { preHandler: requireAdmin }, async (request) => formatSuccess(await service.createPermission(permissionSchema.parse(request.body))));
  app.post<{ Params: { roleId: string; permissionId: string } }>('/api/v1/roles/:roleId/permissions/:permissionId', { preHandler: requireAdmin }, async (request) => formatSuccess(await service.assignPermission(request.user!.userId, request.params.roleId, request.params.permissionId)));
  app.post<{ Params: { userId: string; roleId: string } }>('/api/v1/users/:userId/roles/:roleId', { preHandler: requireAdmin }, async (request) => formatSuccess(await service.assignRole(request.user!.userId, request.params.userId, request.params.roleId)));
  app.get<{ Params: { permission: string } }>('/api/v1/permissions/check/:permission', { preHandler: authMiddleware }, async (request) => formatSuccess({ allowed: await service.hasPermission(request.user!.userId, request.params.permission) }));
};
