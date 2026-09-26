import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { UnauthorizedError } from '../utils/errors';
import { isTokenBlacklisted } from '../utils/token-blacklist';
import { config } from '../config';
import { setRequestContextUserId } from '../lib/requestContext';
import { registerAuthGuard } from './auth-guards';

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
    
    // Check if token is blacklisted
    const isBlacklisted = await isTokenBlacklisted(token);
    if (isBlacklisted) {
      throw new UnauthorizedError('Token has been revoked');
    }

    const payload = verifyToken(token);
    request.user = payload;
    // So every log line for the rest of this request — including from
    // code that only has access to the module-level `logger`, not
    // `request` — carries userId too (#26).
    setRequestContextUserId(payload.userId);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError('Invalid token');
  }
};

registerAuthGuard(authMiddleware);

export const optionalAuthMiddleware = async (
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      
      // Check if token is blacklisted
      const isBlacklisted = await isTokenBlacklisted(token);
      if (isBlacklisted) {
        return;
      }

      const payload = verifyToken(token);
      request.user = payload;
    }
  } catch {
    // Silently ignore if token is invalid for optional auth
  }
};