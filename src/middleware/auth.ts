import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { UnauthorizedError } from '../utils/errors';

declare module 'fastify' {
  interface FastifyInstance {
    user?: { userId: string; email: string; role: string };
  }
  interface FastifyRequest {
    user?: { userId: string; email: string; role: string };
  }
}

export const authMiddleware = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const payload = verifyToken(token);
    request.user = payload;
  } catch (error) {
    throw new UnauthorizedError('Invalid token');
  }
};

export const optionalAuthMiddleware = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = verifyToken(token);
      request.user = payload;
    }
  } catch {
    // Silently ignore if token is invalid for optional auth
  }
};
