/**
 * Application entry point.
 *
 * Boot order matters:
 *   1. Config (src/config) — validated at import time; invalid config aborts
 *      the process before anything else happens (issue #60).
 *   2. Config warnings (unsafe-but-valid settings) are logged as one block.
 *   3. Rate limiting is registered first (its onRoute hook classifies every
 *      route, so it must exist before any route is added — issue #1).
 *   4. Security plugins (helmet + CORS + preflight limiter — issue #28).
 *   5. Routes, GraphQL, metrics.
 *   6. Graceful shutdown (issue #23): flip readiness, drain, close in order.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import { config } from './config/env';
import { applyJsonSerializer } from './config/serialization';
import { setServiceState } from './services/health.service';
import {
  initializeDatabase,
  closeDatabase,
  checkDatabaseHealth,
  getPoolMetrics,
  getCircuitBreaker,
} from './db';
import { createInstrumentedPrismaClient, getPrismaPerformanceMonitor } from './db/prisma-performance';
import { getCircuitBreakerSnapshots as getExternalBreakerSnapshots } from './lib/circuit-breaker';
import { registerAuthRoutes } from './domains/auth/auth.routes';
import { registerTwoFactorRoutes } from './domains/auth/two-factor.routes';
import { registerWalletRoutes } from './domains/auth/wallet.routes';
import { registerPaymentRoutes } from './domains/payments/payment.routes';
import { registerChargeRoutes } from './domains/payments/charge.routes';
import { registerUserRoutes } from './domains/users/user.routes';
import { registerCreatorPayoutRoutes } from './domains/creators/payout.routes';
import { registerTeamRoutes } from './domains/teams/team.routes';
import { registerWebhookRoutes } from './domains/webhooks/webhook.routes';
import { registerIncomingWebhookRoutes } from './domains/webhooks/webhook-incoming.routes';
import { registerAnalyticsRoutes } from './domains/analytics/analytics.routes';
import { registerAdminRoutes } from './domains/admin/admin.routes';
import { registerMediaRoutes } from './domains/media/media.routes';
import { registerModerationRoutes } from './domains/moderation/moderation.routes';
import { registerRoleRoutes } from './domains/roles/role.routes';
import { registerNotificationRoutes } from './domains/notifications/notification.routes';
import { registerReferralRoutes } from './domains/referrals/referral.routes';
import { registerMetricsRoute } from './routes/metrics.routes';
import { registerReportRoutes } from './domains/reports/report.routes';
import { registerPrivacyRoutes } from './domains/privacy/privacy.routes';
import { registerQueryPerformanceRoutes } from './routes/query-performance.routes';
import { registerJobRoutes } from './domains/jobs/jobs.routes';
import { registerAssetRoutes } from './domains/assets/asset.routes';
import { registerApm } from './lib/apm';
import { closeQueues } from './lib/queue';
import redisPool, { closeRedisPool, startRedisHealthCheck } from './lib/redisPool';
import { emailNotificationWorker } from './lib/workers/email-notification.worker';
import { initTokenBlacklist, closeTokenBlacklist } from './utils/token-blacklist';
import { parseTrustProxy } from './config/rate-limit';
import { collectConfigWarnings, logConfigWarnings } from './config/warnings';
import { logger } from './utils/logger';
import { registerRateLimiting } from './plugins/rateLimit';
import { registerResponseOptimization } from './plugins/responseOptimization';
import { swaggerConfig } from './config/swagger';
import { registerSecurityPlugins } from './plugins/security';
import { registerApiVersioning } from './plugins/apiVersion';
import { globalErrorHandler, notFoundHandler } from './middleware/error-handler';
import { registerGraphQL } from './graphql/plugin';
import { createCreatorTierRuntime } from './domains/creators/tier.runtime';
import { registerRequestLogging } from './plugins/requestLogging';
import { resolveRequestId } from './lib/requestContext';
import { startCacheInvalidationSubscriber, stopCacheInvalidationSubscriber } from './lib/cache/invalidation';

// Behind a reverse proxy, TRUST_PROXY makes request.ip the real client
// address instead of the proxy's, so per-IP rate limits don't bucket every
// user together. See docs/RATE_LIMITING.md.
const trustProxy = parseTrustProxy(config.TRUST_PROXY);

const app = Fastify({
  trustProxy,
  genReqId: (request) => {
    const incoming = request.headers['x-request-id'];
    return resolveRequestId(incoming, randomUUID);
  },
  logger: {
    level: config.LOG_LEVEL,
  },
}) as unknown as FastifyInstance;

// Register before all application hooks/routes so context and response IDs
// cover normal responses, validation failures, and unknown routes.
registerRequestLogging(app);

// Unsafe-but-valid settings (e.g. TRUST_PROXY=true) are reported together on
// boot; see src/config/warnings.ts.
logConfigWarnings(logger, collectConfigWarnings());

// Rate limiting (#1) classifies routes in an onRoute hook, so it must be
// registered before any route is added.
await registerRateLimiting(app);
registerApm(app);
await app.register(compress, {
  global: config.RESPONSE_COMPRESSION_ENABLED,
  encodings: ['br', 'gzip', 'deflate'],
  threshold: 1024,
});
await app.register(swagger, swaggerConfig.openapi);
await app.register(swaggerUi, swaggerConfig.uiConfig);
registerResponseOptimization(app);

// Initialize Prisma with query performance instrumentation (issue #12):
// duration metrics, slow-query logging, short-lived read cache and unbounded
// read detection. The returned client is a regular PrismaClient.
const { client: prisma } = createInstrumentedPrismaClient();
const creatorTiers = createCreatorTierRuntime(prisma);

// Response schemas are documentation-only; see config/serialization.ts.
applyJsonSerializer(app);

// Register plugins
app.register(cookie, {
  secret: config.JWT_SECRET,
});

// Register routes
registerAuthRoutes(app, prisma);
registerTwoFactorRoutes(app, prisma);
registerWalletRoutes(app, prisma);
registerPaymentRoutes(app, prisma);
registerUserRoutes(app, prisma);
registerCreatorPayoutRoutes(app, prisma);
registerWebhookRoutes(app, prisma);
registerIncomingWebhookRoutes(app, prisma);
registerAnalyticsRoutes(app, prisma);
registerNotificationRoutes(app, prisma);
registerAdminRoutes(app, prisma);
registerRoleRoutes(app, prisma);
registerMediaRoutes(app, prisma);
registerModerationRoutes(app, prisma);
registerMetricsRoute(app, prisma);
registerReportRoutes(app, prisma);
registerPrivacyRoutes(app, prisma);
registerQueryPerformanceRoutes(app, prisma);
registerJobRoutes(app, prisma);

// Health check endpoint
app.get('/health', async (_request, _reply) => {
  const dbHealth = await checkDatabaseHealth();
  const poolMetrics = getPoolMetrics();
  const cb = getCircuitBreaker();

  const isHealthy = dbHealth.status === 'healthy';
  const isDegraded = dbHealth.status === 'degraded';

  const checks = {
    status: isHealthy ? 'ok' : isDegraded ? 'degraded' : 'unhealthy',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
    uptime: process.uptime(),
    dependencies: {
      database: {
        status: dbHealth.status,
        latency: dbHealth.latencyMs >= 0 ? `${dbHealth.latencyMs}ms` : 'unknown',
        pool: {
          total: poolMetrics.totalCount,
          active: poolMetrics.activeCount,
          idle: poolMetrics.idleCount,
          waiting: poolMetrics.waitingCount,
        },
        circuitBreaker: {
          state: cb.getState(),
          failures: cb.getMetrics().failures,
          tripCount: cb.getMetrics().tripCount,
        },
      },
      redis: {
        status: redisPool && (redisPool.size ?? 0) > 0 ? 'healthy' : 'degraded',
      },
      query_performance: (() => {
        const stats = getPrismaPerformanceMonitor().getStats();
        return {
          total_queries: stats.totalQueries,
          slow_queries: stats.slowQueries,
          cache_hit_rate: stats.cache.hitRate,
          unbounded_reads: stats.unboundedReads,
        };
      })(),
      external_services: {
        circuit_breakers: getExternalBreakerSnapshots(),
      },
      memory: {
        status: 'healthy',
        usage: `${Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)}%`,
      },
      nodejs: {
        version: process.version,
        status: 'healthy',
      },
    },
  };

  return checks;
});

// Global error handling: every thrown/validation error is normalized into the
// standardized error envelope, sanitized, logged with full server-side context
// and forwarded to the configured error tracker.
app.setErrorHandler(globalErrorHandler);
app.setNotFoundHandler(notFoundHandler);

// Service becomes "ready" only once Fastify has finished booting (all
// plugins/routes registered) - readiness stays 503 until this fires, so
// load balancers don't route traffic before the process can serve it.
app.addHook('onReady', async () => {
  setServiceState('ready');
});

// Graceful shutdown (#23): flip readiness to `shutting_down` first so the
// readiness probe starts failing immediately (giving the load balancer a
// chance to stop routing new traffic to this instance), then drain and
// close everything in order: (1) stop accepting new connections and let
// in-flight requests finish (Fastify's own close()), (2) close the job
// queues (Redis + BullMQ), (3) close the database connection pool. A hard
// timeout forces exit if any step hangs, so a stuck close() can't leave
// the process running forever under an orchestrator expecting it to stop.
let shuttingDown = false;

const shutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Received ${signal}, starting graceful shutdown`);
  setServiceState('shutting_down');

  const forceExitTimer = setTimeout(() => {
    app.log.error(
      `Graceful shutdown did not complete within ${config.SHUTDOWN_TIMEOUT_MS}ms, forcing exit`
    );
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    // Stops accepting new connections and resolves once in-flight
    // requests have completed (bounded by Fastify's own close semantics;
    // the forceExitTimer above is the outer safety net for this whole
    // sequence, including this step).
    await app.close();
    // Flush buffered creator usage counters before the database goes away.
    await stopCacheInvalidationSubscriber();
    await emailNotificationWorker.close();
    await closeQueues();
    await closeRedisPool();
    await closeDatabase();
    await prisma.$disconnect();
    closeTokenBlacklist();
    app.log.info('Database connections closed');

    clearTimeout(forceExitTimer);
    app.log.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExitTimer);
    app.log.error(err, 'Error during graceful shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

const bootstrap = async (): Promise<void> => {
  await registerSecurityPlugins(app);

  await initTokenBlacklist(prisma);
  await startCacheInvalidationSubscriber();

  // API versioning (#25): validates an optional API-Version header against
  // SUPPORTED_API_VERSIONS and records per-version usage metrics. Existing
  // /api/v1/... paths are untouched — this only adds header validation and
  // observability.
  registerApiVersioning(app);

  registerAuthRoutes(app, prisma);
  registerTwoFactorRoutes(app, prisma);
  registerWalletRoutes(app, prisma);
  registerPaymentRoutes(app, prisma);
  registerChargeRoutes(app, prisma);
  registerUserRoutes(app, prisma);
  registerCreatorPayoutRoutes(app, prisma);
  registerTeamRoutes(app, prisma);
  registerWebhookRoutes(app, prisma);
  registerIncomingWebhookRoutes(app, prisma);
  registerAnalyticsRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  registerReferralRoutes(app, prisma);
  registerMetricsRoute(app, prisma);
  registerQueryPerformanceRoutes(app);
  registerJobRoutes(app);
  registerAssetRoutes(app, prisma);

  await registerGraphQL(app, prisma);
};

const start = async (): Promise<void> => {
  try {
    await bootstrap();

    if (config.DATABASE_URL) {
      try {
        await initializeDatabase();
      } catch (dbErr) {
        app.log.warn({ dbErr }, 'Database pool initialization warning, continuing startup');
      }
    }

    startRedisHealthCheck();

if (config.ENABLE_WORKERS || config.JOBS_WORKERS_ENABLED) {
      const { startWorkers } = await import('./lib/workers/index');
      startWorkers(prisma).catch((err) => {
        app.log.error({ err }, 'Failed to start background workers');
      });
    }

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
