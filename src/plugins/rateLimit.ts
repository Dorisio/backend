import { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import rateLimit, { RateLimitOptions } from '@fastify/rate-limit';
import IORedis from 'ioredis';
import jwt, { Secret } from 'jsonwebtoken';
import { config } from '../config/env';
import {
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_EXEMPTIONS,
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_RULES,
  RATE_LIMIT_STORE,
  RateLimitClass,
  RateLimitPolicy,
  RateLimitRule,
  RouteMatcher,
  routeMatches,
} from '../config/rate-limit';
import { isAuthGuard } from '../middleware/auth-guards';
import { TooManyRequestsError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Centralized API rate limiting (issue #1), built on @fastify/rate-limit.
 *
 * Every route is classified once, when it is registered, from the tables in
 * src/config/rate-limit.ts. The resolved policy is written into the route's
 * `config.rateLimit`, which @fastify/rate-limit reads to attach an onRequest
 * hook. Exempt routes get `rateLimit: false`, so no hook is attached at all.
 *
 * Counters are kept per client, per route: each route has its own bucket
 * sized by its class.
 */

export type RouteClassification = RateLimitClass | 'exempt';

export interface RateLimitingOptions {
  enabled?: boolean;
  policies?: Record<RateLimitClass, RateLimitPolicy>;
  rules?: RateLimitRule[];
  exemptions?: RouteMatcher[];
  store?: 'memory' | 'redis';
}

const LIFECYCLE_HOOKS = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const;

function routeHasAuthGuard(routeOptions: RouteOptions): boolean {
  return LIFECYCLE_HOOKS.some((name) => {
    const hook = routeOptions[name];
    return Array.isArray(hook) ? hook.some(isAuthGuard) : isAuthGuard(hook);
  });
}

function classifyMethod(
  method: string,
  url: string,
  hasAuthGuard: boolean,
  rules: RateLimitRule[],
  exemptions: RouteMatcher[]
): RouteClassification {
  // Fastify auto-registers HEAD for every GET; treat them alike.
  const effective = method === 'HEAD' ? 'GET' : method;
  if (exemptions.some((m) => routeMatches(m, effective, url))) return 'exempt';
  const rule = rules.find((r) => routeMatches(r, effective, url));
  if (rule) return rule.class;
  return hasAuthGuard ? 'authenticated' : 'public';
}

/**
 * Resolves a route's class. A route registered for several methods gets the
 * most restrictive class among them, and is exempt only if every method is.
 */
export function classifyRoute(
  routeOptions: RouteOptions,
  policies: Record<RateLimitClass, RateLimitPolicy> = RATE_LIMIT_POLICIES,
  rules: RateLimitRule[] = RATE_LIMIT_RULES,
  exemptions: RouteMatcher[] = RATE_LIMIT_EXEMPTIONS
): RouteClassification {
  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
  const hasAuthGuard = routeHasAuthGuard(routeOptions);
  const classes = methods.map((m) =>
    classifyMethod(m.toUpperCase(), routeOptions.url, hasAuthGuard, rules, exemptions)
  );

  const limited = classes.filter((c): c is RateLimitClass => c !== 'exempt');
  if (limited.length === 0) return 'exempt';

  const rate = (c: RateLimitClass) => policies[c].max / policies[c].timeWindowMs;
  return limited.reduce((strictest, c) => (rate(c) < rate(strictest) ? c : strictest));
}

/**
 * Identifies the client a request is counted against: the authenticated
 * user when the request carries a validly signed access token, otherwise the
 * client IP. `request.ip` honours the server's `trustProxy` setting, so behind
 * a correctly configured proxy it is the real client address.
 *
 * The limiter runs in onRequest, before the route's auth preHandler, so the
 * token is verified here directly. Only the signature and expiry matter for
 * bucketing (a forged token cannot claim another user's bucket); the full
 * auth check, including revocation, still runs in authMiddleware.
 */
export function resolveClientKey(request: FastifyRequest): string {
  if (request.user?.userId) return `user:${request.user.userId}`;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), config.JWT_SECRET as Secret);
      if (payload && typeof payload === 'object' && typeof payload.userId === 'string') {
        return `user:${payload.userId}`;
      }
    } catch {
      // Invalid or expired token: fall back to the IP. Not logged, so bad
      // tokens cannot be used to flood the logs.
    }
  }

  return `ip:${request.ip}`;
}

function buildRoutePolicy(routeClass: RateLimitClass, policy: RateLimitPolicy): RateLimitOptions {
  return {
    max: policy.max,
    timeWindow: policy.timeWindowMs,
    errorResponseBuilder: (_request, context) =>
      // The message matches the catalog entry so the global error handler
      // can localize it; the thrown error flows through globalErrorHandler.
      new TooManyRequestsError('Too many requests, please try again later', {
        policy: routeClass,
        limit: context.max,
        windowMs: policy.timeWindowMs,
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
    onExceeded: (request, key) => {
      logger.warn(
        { key, policy: routeClass, method: request.method, url: request.url, requestId: request.id },
        'Rate limit exceeded'
      );
    },
  };
}

export async function registerRateLimiting(
  app: FastifyInstance,
  options: RateLimitingOptions = {}
): Promise<void> {
  // Disabling is reported at boot by src/config/warnings.ts.
  if (!(options.enabled ?? RATE_LIMIT_ENABLED)) return;

  const policies = options.policies ?? RATE_LIMIT_POLICIES;
  const rules = options.rules ?? RATE_LIMIT_RULES;
  const exemptions = options.exemptions ?? RATE_LIMIT_EXEMPTIONS;
  const store = options.store ?? RATE_LIMIT_STORE;

  const routePolicies = Object.fromEntries(
    (Object.keys(policies) as RateLimitClass[]).map((c) => [c, buildRoutePolicy(c, policies[c])])
  ) as Record<RateLimitClass, RateLimitOptions>;

  // Must be added before @fastify/rate-limit registers its own onRoute hook,
  // which reads `config.rateLimit`; onRoute hooks run in registration order.
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.rateLimit !== undefined) {
      throw new Error(
        `Route ${routeOptions.method} ${routeOptions.url} sets config.rateLimit inline; ` +
          'rate limits are assigned centrally in src/config/rate-limit.ts'
      );
    }

    const routeClass = classifyRoute(routeOptions, policies, rules, exemptions);
    routeOptions.config = {
      ...routeOptions.config,
      rateLimit: routeClass === 'exempt' ? false : routePolicies[routeClass],
    };
  });

  let redis: IORedis | undefined;
  if (store === 'redis') {
    redis = new IORedis(config.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 });
    app.addHook('onClose', async () => {
      await redis?.quit();
    });
  }

  await app.register(rateLimit, {
    // Every route receives an explicit policy (or `false`) above.
    global: false,
    keyGenerator: resolveClientKey,
    // Per-route LRU size for the in-memory store.
    cache: 10000,
    redis,
    nameSpace: 'rate-limit:',
    // If Redis is unreachable, serve the request rather than fail it.
    skipOnError: store === 'redis',
  });
}
