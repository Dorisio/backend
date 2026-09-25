import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  checkDatabaseHealth,
  checkCacheHealth,
  checkStellarHealth,
  getServiceState,
  type CacheClient,
  type DependencyCheckResult,
} from '../services/health.service';
import { getStellarClient } from '../lib/stellar/client';

interface HealthChecksResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  timestamp: string;
  environment: string;
  uptime: number;
  checks: Record<string, DependencyCheckResult>;
}

/**
 * Aggregates individual dependency check results into an overall status:
 *  - 'unavailable' if any *critical* dependency is unhealthy
 *  - 'degraded' if only non-critical dependencies are unhealthy
 *  - 'ok' otherwise
 */
function aggregateStatus(
  checks: Record<string, DependencyCheckResult>
): 'ok' | 'degraded' | 'unavailable' {
  const results = Object.values(checks);
  const criticalDown = results.some((c) => c.critical && c.status !== 'healthy');
  if (criticalDown) return 'unavailable';

  const nonCriticalDown = results.some((c) => !c.critical && c.status !== 'healthy');
  if (nonCriticalDown) return 'degraded';

  return 'ok';
}

/**
 * Resolves the Stellar client and runs its health check defensively.
 * `getStellarClient()` can throw synchronously (e.g. misconfigured
 * network/secret key), and since Stellar connectivity is a non-critical
 * check, a construction failure should degrade the readiness response
 * rather than blow up the route handler.
 */
async function getStellarNetworkHealth(): Promise<DependencyCheckResult> {
  try {
    const client = getStellarClient();
    return await checkStellarHealth(client);
  } catch (error) {
    return {
      status: 'unhealthy',
      critical: false,
      message: error instanceof Error ? error.message : 'Failed to initialize Stellar client',
    };
  }
}

export const registerHealthRoutes = (
  app: FastifyInstance,
  prisma: PrismaClient,
  cache: CacheClient
): void => {
  // GET /health - liveness probe
  //
  // Answers "is the process running and responsive?". Intentionally
  // lightweight: it performs a quick, timeout-bound database check as a
  // sanity signal (per the issue's own framing) but must NOT fail just
  // because a non-critical dependency (e.g. the Stellar network) is
  // briefly degraded. Orchestrators use this to decide whether to
  // restart the process, so it should only fail on process-fatal
  // conditions, not on downstream dependency blips.
  app.get('/health', async (_request, reply) => {
    const database = await checkDatabaseHealth(prisma);

    const body: HealthChecksResponse = {
      status: database.status === 'healthy' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      checks: {
        database,
      },
    };

    // Liveness never returns 503 for dependency issues alone - only the
    // process being unresponsive would prevent this handler from running
    // at all. We still surface degraded dependency info for monitoring.
    reply.code(200);
    return body;
  });

  // GET /readiness - readiness probe
  //
  // Answers "is the process ready to serve traffic?". Checks all critical
  // dependencies (database, cache) plus best-effort external API checks
  // (Stellar Horizon/RPC), and is gated by the service lifecycle state so
  // it fails fast during startup and during graceful shutdown.
  app.get('/readiness', async (_request, reply) => {
    const state = getServiceState();

    if (state !== 'ready') {
      const body: HealthChecksResponse = {
        status: 'unavailable',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        uptime: process.uptime(),
        checks: {
          service: {
            status: 'unhealthy',
            critical: true,
            message: `Service is ${state}`,
          },
        },
      };
      reply.code(503);
      return body;
    }

    const [database, cacheResult, stellar] = await Promise.all([
      checkDatabaseHealth(prisma),
      checkCacheHealth(cache),
      getStellarNetworkHealth(),
    ]);

    const checks: Record<string, DependencyCheckResult> = {
      database,
      cache: cacheResult,
      stellar,
    };

    const status = aggregateStatus(checks);

    const body: HealthChecksResponse = {
      status,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      checks,
    };

    reply.code(status === 'unavailable' ? 503 : 200);
    return body;
  });
};
