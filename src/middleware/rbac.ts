import { FastifyRequest, FastifyReply } from 'fastify';
import { UserRole, hasAnyRole } from '../utils/roles';
import { ForbiddenError } from '../utils/errors';
import { authMiddleware } from './auth';
import { registerAuthGuard } from './auth-guards';

export const requireRole = (allowedRoles: UserRole[]) => {
  return registerAuthGuard(async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authMiddleware(request, reply);

    if (!request.user) {
      // authMiddleware already rejected unauthenticated requests; reaching
      // here without a user is a contract violation.
      throw new ForbiddenError('User not found');
    }

    // Authenticated but not allowed: 403 (Forbidden), not 401 — the user
    // identified fine, the role is the problem (issue #35).
    if (!hasAnyRole(request.user.role, allowedRoles)) {
      throw new ForbiddenError('Insufficient permissions');
    }
  });
};

export const requireAdmin = requireRole([UserRole.ADMIN]);

export const requireCreator = requireRole([UserRole.CREATOR, UserRole.ADMIN]);
