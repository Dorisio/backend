import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config, getCorsOrigins } from '../config/env';
import { logger } from '../utils/logger';

/** Simple in-memory rate limit for CORS preflight (Issue #28). */
const preflightHits = new Map<string, { count: number; resetAt: number }>();
const PREFLIGHT_LIMIT = 60;
const PREFLIGHT_WINDOW_MS = 60_000;

export async function rateLimitCorsPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.method !== 'OPTIONS') return;

  const ip = request.ip || 'unknown';
  const now = Date.now();
  let entry = preflightHits.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + PREFLIGHT_WINDOW_MS };
    preflightHits.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > PREFLIGHT_LIMIT) {
    logger.warn({ ip }, 'CORS preflight rate limit exceeded');
    reply.code(429).send({
      error: 'Too many preflight requests',
      code: 'CORS_PREFLIGHT_RATE_LIMIT',
    });
  }
}

export async function registerSecurityPlugins(app: FastifyInstance): Promise<void> {
  const origins = getCorsOrigins();

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy:
      config.NODE_ENV === 'production'
        ? {
            directives: {
              defaultSrc: ["'self'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      config.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
  });

  await app.register(cors, {
    origin: origins,
    credentials: config.CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: config.CORS_MAX_AGE,
    preflight: true,
    strictPreflight: true,
  });

  app.addHook('onRequest', rateLimitCorsPreflight);
}
