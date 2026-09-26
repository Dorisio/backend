/**
 * Central rate-limit configuration (issue #1).
 *
 * This is the ONLY place where rate limits are decided. Route handlers never
 * declare their own limit: every route is classified here, at registration
 * time, by matching its method + URL pattern against the tables below. See
 * docs/RATE_LIMITING.md for how to classify a new route or add an exemption.
 */
import { config } from './env';

export type RateLimitClass = 'public' | 'authenticated' | 'sensitive';

export interface RateLimitPolicy {
  /** Requests allowed per client, per route, within `timeWindowMs`. */
  max: number;
  timeWindowMs: number;
}

/**
 * Matches a route by its registered URL pattern (e.g. `/api/v1/wallet/:walletId`,
 * not the concrete request path). `url` may be an exact pattern, a prefix
 * ending in `/*`, or `*` for any route. Omitting `method` matches every method.
 */
export interface RouteMatcher {
  method?: string | string[];
  url: string;
}

export interface RateLimitRule extends RouteMatcher {
  class: RateLimitClass;
}

export const RATE_LIMIT_POLICIES: Record<RateLimitClass, RateLimitPolicy> = {
  public: {
    max: config.RATE_LIMIT_PUBLIC_MAX,
    timeWindowMs: config.RATE_LIMIT_PUBLIC_WINDOW_MS,
  },
  authenticated: {
    max: config.RATE_LIMIT_AUTHENTICATED_MAX,
    timeWindowMs: config.RATE_LIMIT_AUTHENTICATED_WINDOW_MS,
  },
  sensitive: {
    max: config.RATE_LIMIT_SENSITIVE_MAX,
    timeWindowMs: config.RATE_LIMIT_SENSITIVE_WINDOW_MS,
  },
};

/**
 * Routes that bypass rate limiting entirely (no hook is attached to them).
 * Orchestrator probes must never be throttled, and CORS preflights already
 * have their own limiter in plugins/security.ts.
 */
export const RATE_LIMIT_EXEMPTIONS: RouteMatcher[] = [
  { method: 'GET', url: '/health' },
  { method: 'GET', url: '/readiness' },
  { method: 'OPTIONS', url: '*' },
];

/**
 * Explicit classifications, first match wins. Routes that match no rule are
 * classified automatically: `authenticated` when the route runs an auth guard
 * (authMiddleware, requireAdmin, requireCreator, ...), otherwise `public`.
 */
export const RATE_LIMIT_RULES: RateLimitRule[] = [
  // Credential and wallet-signature endpoints: brute-force targets.
  { method: 'POST', url: '/api/v1/auth/login', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/auth/register', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/auth/refresh', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/wallet/nonce', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/wallet/verify', class: 'sensitive' },

  // Money movement.
  { method: 'POST', url: '/api/v1/transactions/tip', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/transactions/:id/build', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/transactions/:id/submit', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/payments', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/payments/:id/refund', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/creators/payout', class: 'sensitive' },

  // Resource intensive: Stellar Horizon round-trips, job enqueueing, cache
  // warming and EXPLAIN queries.
  { method: 'GET', url: '/api/v1/wallet/:walletId/balance', class: 'sensitive' },
  { method: 'GET', url: '/api/v1/transactions/:id/confirm', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/jobs/*', class: 'sensitive' },
  { method: 'POST', url: '/api/v1/admin/cache/warm', class: 'sensitive' },
  { method: 'POST', url: '/diagnostics/queries/explain', class: 'sensitive' },
];

/** Where counters are kept. Use `redis` when running more than one instance. */
export const RATE_LIMIT_STORE = config.RATE_LIMIT_STORE;
export const RATE_LIMIT_ENABLED = config.RATE_LIMIT_ENABLED;

function matchesMethod(matcher: RouteMatcher, method: string): boolean {
  if (!matcher.method) return true;
  const methods = Array.isArray(matcher.method) ? matcher.method : [matcher.method];
  return methods.some((m) => m.toUpperCase() === method.toUpperCase());
}

function matchesUrl(pattern: string, url: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return url === prefix || url.startsWith(`${prefix}/`);
  }
  return pattern === url;
}

export function routeMatches(matcher: RouteMatcher, method: string, url: string): boolean {
  return matchesMethod(matcher, method) && matchesUrl(matcher.url, url);
}

/**
 * Parses TRUST_PROXY into Fastify's `trustProxy` option.
 *
 * `true` is accepted but discouraged: it makes Fastify take the left-most
 * X-Forwarded-For entry, which any client can forge to evade rate limiting.
 * Prefer a hop count or the proxy's address range.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const raw = (value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
