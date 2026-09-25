import { FastifyRequest, FastifyReply } from 'fastify';
import cacheService, { CacheService } from '../lib/cache';

/**
 * HTTP response caching middleware (Express-style API kept from the Redis
 * caching PR, but wired to Fastify's request/reply objects used elsewhere in
 * this service).
 */
export interface CacheOptions {
  ttl?: number;
  key?: string;
  sensitive?: boolean;
}

export function cacheMiddleware(options: CacheOptions = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.sensitive || req.method !== 'GET') {
      return;
    }

    const cacheKey = options.key || `req:${req.method}:${req.url}`;
    try {
      const cached = await cacheService.get<{ body: unknown; statusCode: number }>(cacheKey);
      if (cached) {
        reply.code(cached.statusCode).send(cached.body);
        return;
      }

      // Capture the JSON payload once the route handler sends it.
      const originalSend = reply.send.bind(reply);
      reply.send = ((body: unknown) => {
        const statusCode = reply.statusCode || 200;
        void cacheService.set(cacheKey, { body, statusCode }, options.ttl);
        return originalSend(body);
      }) as typeof reply.send;
    } catch (error) {
      req.log.error({ error }, 'Cache middleware error');
    }
  };
}

export function invalidateCacheMiddleware(options: { pattern?: string } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      await cacheService.invalidatePattern(options.pattern || '*');
    }
  };
}

export async function getCacheMetrics(_req: FastifyRequest, reply: FastifyReply) {
  reply.send(cacheService.getMetrics());
}

export { CacheService };
