import { Request, Response, NextFunction } from 'express';
import { cacheService } from '../lib/cache';

export interface CacheOptions {
  ttl?: number;
  key?: string;
  sensitive?: boolean;
}

export function cacheMiddleware(options: CacheOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (options.sensitive) {
      return next();
    }

    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = options.key || `req:${req.method}:${req.originalUrl}`;

    try {
      const cached = await cacheService.get<{ body: any; statusCode: number }>(cacheKey);

      if (cached) {
        res.status(cached.statusCode).json(cached.body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        const statusCode = res.statusCode || 200;
        cacheService.set(cacheKey, { body, statusCode }, options.ttl).catch(() => {
          // Ignore cache set errors
        });
        return originalJson(body);
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error);
      next();
    }
  };
}

export function invalidateCacheMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const pattern = options?.pattern || '*';
      await cacheService.invalidatePattern(pattern);
    }
    next();
  };
}

export function getCacheMetrics(req: Request, res: Response) {
  const metrics = cacheService.getMetrics();
  res.json(metrics);
}