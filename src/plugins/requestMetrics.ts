/**
 * Request logging + metrics collection hook (#54).
 *
 * Fastify's onResponse hook is the only place where a request's final status
 * code, route pattern and measured duration are all available, so that is where
 * a request is logged and recorded. The route pattern (`/api/v1/transactions/:id`)
 * is used rather than the concrete URL so metrics group by endpoint instead of
 * exploding into one series per id.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requestDurationHistogram } from '../lib/metrics';
import {
  RequestMetricsStore,
  getRequestMetricsStore,
  shouldTrackRoute,
} from '../lib/request-metrics';

/** Requests slower than this are logged at warn level so they surface in logs. */
export const SLOW_REQUEST_THRESHOLD_MS = 1000;

/** The route pattern for a request, falling back to the path without query. */
export function resolveRoutePattern(request: FastifyRequest): string {
  const route = (request as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (route) return route;
  return request.url.split('?')[0];
}

export interface RegisterRequestMetricsOptions {
  store?: RequestMetricsStore;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Registers the collection hook. Idempotent: the entrypoint calls the metrics
 * registration twice, and a second hook would double-count every request.
 */
let hookRegistered = false;

export function registerRequestMetrics(
  app: FastifyInstance,
  options: RegisterRequestMetricsOptions = {}
): RequestMetricsStore {
  const store = options.store ?? getRequestMetricsStore();
  if (hookRegistered) return store;
  hookRegistered = true;

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = resolveRoutePattern(request);
    if (!shouldTrackRoute(route)) return;

    const durationMs =
      reply.elapsedTime ?? (request as unknown as { elapsedTime?: number }).elapsedTime ?? 0;
    const userId = request.user?.userId;

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS || reply.statusCode >= 500) {
      request.log.warn(
        {
          method: request.method,
          route,
          statusCode: reply.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          userId,
        },
        reply.statusCode >= 500 ? 'API request failed' : 'Slow API request'
      );
    } else {
      request.log.info(
        {
          method: request.method,
          route,
          statusCode: reply.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          userId,
        },
        'API request completed'
      );
    }

    store.record({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
      userId,
      ip: request.ip,
      timestamp: options.now ? new Date(options.now()) : undefined,
    });

    // Keep the Prometheus series in step with the in-process store.
    requestDurationHistogram.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      durationMs / 1000
    );
  });

  return store;
}

/** Test seam: allow the hook to be registered again in a fresh app. */
export function resetRequestMetricsHook(): void {
  hookRegistered = false;
}
