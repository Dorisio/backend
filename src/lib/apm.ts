import { Counter, Gauge, Histogram } from 'prom-client';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveRoutePattern } from '../plugins/requestMetrics';

export const apmRequestDuration = new Histogram({ name: 'dorisio_apm_request_duration_seconds', help: 'Sampled request trace duration', labelNames: ['method', 'route', 'status'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5] });
export const apmErrors = new Counter({ name: 'dorisio_apm_errors_total', help: 'Errors grouped by endpoint and type', labelNames: ['route', 'type'] });
export const apmSlowRequests = new Counter({ name: 'dorisio_apm_slow_requests_total', help: 'Requests over the configured latency threshold', labelNames: ['route'] });
export const apmMemoryUsage = new Gauge({ name: 'dorisio_apm_memory_heap_used_bytes', help: 'Node.js heap used by the process' });

const sampled = () => Math.random() < Number(process.env.APM_SAMPLE_RATE ?? '0.25');

export function registerApm(app: FastifyInstance): void {
  if (process.env.APM_ENABLED === 'false') return;
  app.addHook('onRequest', async (request) => {
    if (sampled()) (request as FastifyRequest & { apmStart?: number }).apmStart = performance.now();
  });
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const tracked = request as FastifyRequest & { apmStart?: number };
    if (tracked.apmStart === undefined) return;
    const durationMs = performance.now() - tracked.apmStart;
    const route = resolveRoutePattern(request);
    apmRequestDuration.observe({ method: request.method, route, status: String(reply.statusCode) }, durationMs / 1000);
    if (durationMs > Number(process.env.APM_SLOW_ENDPOINT_MS ?? '1000')) apmSlowRequests.inc({ route });
    if (reply.statusCode >= 400) apmErrors.inc({ route, type: reply.statusCode >= 500 ? 'server' : 'client' });
  });
  setInterval(() => apmMemoryUsage.set(process.memoryUsage().heapUsed), 10_000).unref();
}

export async function traceExternalCall<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); } finally {
    const durationMs = performance.now() - started;
    if (durationMs > Number(process.env.APM_SLOW_EXTERNAL_CALL_MS ?? '1000')) apmSlowRequests.inc({ route: `external:${name}` });
  }
}
