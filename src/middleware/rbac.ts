import { FastifyRequest, FastifyReply } from 'fastify';
import { UserRole, hasAnyRole } from '../utils/roles';
import { UnauthorizedError } from '../utils/errors';
import { authMiddleware } from './auth';
import { registerAuthGuard } from './auth-guards';

export const requireRole = (allowedRoles: UserRole[]) => {
  return registerAuthGuard(async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authMiddleware(request, reply);

    if (!request.user) {
      throw new UnauthorizedError('User not found');
    }

    if (!hasAnyRole(request.user.role, allowedRoles)) {
      throw new UnauthorizedError('Insufficient permissions');
    }
  });
};

export const requireAdmin = requireRole([UserRole.ADMIN]);

export const requireCreator = requireRole([UserRole.CREATOR, UserRole.ADMIN]);
