import { FastifyRequest, FastifyReply } from 'fastify';
import { UserRole, hasAnyRole } from '../utils/roles';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { authMiddleware } from './auth';
import { registerAuthGuard } from './auth-guards';

export const requireRole = (allowedRoles: UserRole[]) => {
  return registerAuthGuard(async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authMiddleware(request, reply);

    if (!request.user) {
      throw new UnauthorizedError('User not found');
    }

    if (!hasAnyRole(request.user.role, allowedRoles)) {
      // Authenticated but lacking the role: 403, not 401. 401 would tell
      // clients to (re-)authenticate, which cannot fix a missing permission.
      throw new ForbiddenError('Insufficient permissions');
    }
  });
};

export const requireAdmin = requireRole([UserRole.ADMIN]);

export const requireCreator = requireRole([UserRole.CREATOR, UserRole.ADMIN]);
