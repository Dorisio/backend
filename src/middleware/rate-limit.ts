import { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetAt: number;
  };
}

const rateLimitStore: RateLimitStore = {};

/**
 * Rate limit middleware for tip creation
 * Limits: 10 tips per hour per user
 */
export async function rateLimitTipCreation(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const user = request.user;

    if (!user) {
      throw new Error('User not found in request');
    }

    const key = `tip:${user.userId}`;
    const now = Date.now();
    const oneHourMs = 60 * 60 * 1000;

    // Initialize or reset if window expired
    if (!rateLimitStore[key] || rateLimitStore[key].resetAt < now) {
      rateLimitStore[key] = {
        count: 0,
        resetAt: now + oneHourMs,
      };
    }

    // Check limit
    if (rateLimitStore[key].count >= 10) {
      const resetAt = new Date(rateLimitStore[key].resetAt).toISOString();
      logger.warn(
        `Rate limit exceeded for user ${user.userId}: ${rateLimitStore[key].count}/10 tips`
      );

      reply.code(429).send({
        success: false,
        error: {
          message: 'Rate limit exceeded. Maximum 10 tips per hour.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
        timestamp: new Date().toISOString(),
      });

      return;
    }

    // Increment counter
    rateLimitStore[key].count++;
  } catch (error) {
    logger.error('Rate limit check failed:', error);
    throw error;
  }
}

/**
 * Cleanup expired rate limit entries (call periodically)
 */
export function cleanupRateLimitStore(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of Object.entries(rateLimitStore)) {
    if (value.resetAt < now) {
      delete rateLimitStore[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
  }
}

/**
 * Get rate limit status for a user
 */
export function getRateLimitStatus(userId: string): { remaining: number; resetAt: string } | null {
  const key = `tip:${userId}`;

  if (!rateLimitStore[key]) {
    return {
      remaining: 10,
      resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  return {
    remaining: Math.max(0, 10 - rateLimitStore[key].count),
    resetAt: new Date(rateLimitStore[key].resetAt).toISOString(),
  };
}
