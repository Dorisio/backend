import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../middleware/rbac';
import { validateRequest } from '../middleware/validation';
import { formatSuccess } from '../types/response';
import { getRequestMetricsStore } from '../lib/request-metrics';

/**
 * Dashboard / metrics query endpoints for request logging (#54).
 *
 * All of them are admin-only: the data includes per-user activity and client
 * addresses. One Zod schema is shared by every endpoint so the filter grammar is
 * identical across the dashboard views.
 */
const MetricsQuerySchema = z.object({
  /** Trailing window to aggregate, in milliseconds (default 1 hour, max 30 days). */
  windowMs: z.coerce.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1000).optional(),
  route: z.string().trim().min(1).max(300).optional(),
  method: z.string().trim().min(1).max(10).optional(),
  /** Volume series granularity, in milliseconds (default 1 minute). */
  bucketMs: z.coerce.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
  topN: z.coerce.number().int().min(1).max(100).optional(),
  format: z.enum(['json', 'prometheus']).optional(),
});

type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

function snapshotFor(query: MetricsQuery) {
  const store = getRequestMetricsStore();
  return store.snapshot(query.windowMs ?? DEFAULT_WINDOW_MS, {
    route: query.route,
    method: query.method,
    bucketMs: query.bucketMs,
    topN: query.topN,
  });
}

/** Renders the aggregated snapshot in the Prometheus text exposition format. */
function toPrometheus(snapshot: ReturnType<typeof snapshotFor>): string {
  const lines: string[] = [];
  lines.push('# HELP dorisio_api_requests_total API requests observed in the aggregation window');
  lines.push('# TYPE dorisio_api_requests_total counter');
  lines.push('# HELP dorisio_api_request_errors_total 5xx responses observed in the aggregation window');
  lines.push('# TYPE dorisio_api_request_errors_total counter');
  lines.push('# HELP dorisio_api_request_duration_ms Request latency quantiles in milliseconds');
  lines.push('# TYPE dorisio_api_request_duration_ms gauge');

  for (const route of snapshot.byRoute) {
    const labels = `route="${route.route}",method="${route.method}"`;
    lines.push(`dorisio_api_requests_total{${labels}} ${route.requests}`);
    lines.push(`dorisio_api_request_errors_total{${labels}} ${route.errors}`);
    lines.push(`dorisio_api_request_duration_ms{${labels},quantile="0.5"} ${route.p50}`);
    lines.push(`dorisio_api_request_duration_ms{${labels},quantile="0.95"} ${route.p95}`);
    lines.push(`dorisio_api_request_duration_ms{${labels},quantile="0.99"} ${route.p99}`);
  }

  return `${lines.join('\n')}\n`;
}

let routesRegistered = false;

/**
 * Idempotent registration: the entrypoint registers the metrics surface twice,
 * and Fastify rejects a duplicated route.
 */
export function registerRequestMetricsRoutes(app: FastifyInstance): void {
  if (routesRegistered) return;
  routesRegistered = true;

  /**
   * GET /api/v1/admin/metrics/requests
   * Full dashboard payload: totals, latency quantiles, per-endpoint breakdown,
   * request volume over time, busiest users and any active alerts.
   */
  app.get<{ Querystring: MetricsQuery }>(
    '/api/v1/admin/metrics/requests',
    {
      preHandler: [requireAdmin, validateRequest({ query: MetricsQuerySchema })],
      schema: {
        tags: ['Metrics'],
        summary: 'API request metrics dashboard',
        description:
          'Aggregated request volume, latency percentiles, per-endpoint success/error rates and alerts.',
        response: { 200: { description: 'Request metrics snapshot' }, 401: { description: 'Unauthorized' } },
      },
    },
    async (request: FastifyRequest<{ Querystring: MetricsQuery }>, reply: FastifyReply) => {
      const snapshot = snapshotFor(request.query);
      if (request.query.format === 'prometheus') {
        reply.type('text/plain; charset=utf-8').send(toPrometheus(snapshot));
        return;
      }
      reply.send(formatSuccess(snapshot));
    }
  );

  /** GET /api/v1/admin/metrics/requests/latency — percentiles only. */
  app.get<{ Querystring: MetricsQuery }>(
    '/api/v1/admin/metrics/requests/latency',
    {
      preHandler: [requireAdmin, validateRequest({ query: MetricsQuerySchema })],
      schema: {
        tags: ['Metrics'],
        summary: 'Request latency percentiles (p50 / p95 / p99)',
        response: { 200: { description: 'Latency percentiles' }, 401: { description: 'Unauthorized' } },
      },
    },
    async (request: FastifyRequest<{ Querystring: MetricsQuery }>, reply: FastifyReply) => {
      const snapshot = snapshotFor(request.query);
      reply.send(
        formatSuccess({
          windowMs: snapshot.windowMs,
          generatedAt: snapshot.generatedAt,
          latency: snapshot.latency,
          topSlowRoutes: snapshot.topSlowRoutes,
        })
      );
    }
  );

  /** GET /api/v1/admin/metrics/requests/endpoints — per-endpoint breakdown. */
  app.get<{ Querystring: MetricsQuery }>(
    '/api/v1/admin/metrics/requests/endpoints',
    {
      preHandler: [requireAdmin, validateRequest({ query: MetricsQuerySchema })],
      schema: {
        tags: ['Metrics'],
        summary: 'Per-endpoint request volume, success rate and latency',
        response: { 200: { description: 'Per-endpoint metrics' }, 401: { description: 'Unauthorized' } },
      },
    },
    async (request: FastifyRequest<{ Querystring: MetricsQuery }>, reply: FastifyReply) => {
      const snapshot = snapshotFor(request.query);
      reply.send(
        formatSuccess({
          windowMs: snapshot.windowMs,
          generatedAt: snapshot.generatedAt,
          endpoints: snapshot.byRoute,
        })
      );
    }
  );

  /** GET /api/v1/admin/metrics/requests/alerts — currently firing thresholds. */
  app.get<{ Querystring: MetricsQuery }>(
    '/api/v1/admin/metrics/requests/alerts',
    {
      preHandler: [requireAdmin, validateRequest({ query: MetricsQuerySchema })],
      schema: {
        tags: ['Metrics'],
        summary: 'Active request anomalies (error rate, p99 latency, traffic spike)',
        response: { 200: { description: 'Active alerts' }, 401: { description: 'Unauthorized' } },
      },
    },
    async (request: FastifyRequest<{ Querystring: MetricsQuery }>, reply: FastifyReply) => {
      const snapshot = snapshotFor(request.query);
      reply.send(
        formatSuccess({
          windowMs: snapshot.windowMs,
          generatedAt: snapshot.generatedAt,
          totals: snapshot.totals,
          alerts: snapshot.alerts,
        })
      );
    }
  );
}

/** Test seam: allow a fresh Fastify instance to register the routes again. */
export function resetRequestMetricsRoutes(): void {
  routesRegistered = false;
}
