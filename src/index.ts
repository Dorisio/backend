import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config/env';
import { applyJsonSerializer } from './config/serialization';
import { AppError } from './utils/errors';
import { setServiceState } from './services/health.service';
import { PrismaClient } from '@prisma/client';
import { initializeDatabase, closeDatabase, checkDatabaseHealth, getPoolMetrics, getCircuitBreaker } from './db';
import { getCircuitBreakerSnapshots as getExternalBreakerSnapshots } from './lib/circuit-breaker';
import { registerAuthRoutes } from './domains/auth/auth.routes';
import { registerWalletRoutes } from './domains/auth/wallet.routes';
import { registerPaymentRoutes } from './domains/payments/payment.routes';
import { registerChargeRoutes } from './domains/payments/charge.routes';
import { registerUserRoutes } from './domains/users/user.routes';
import { registerCreatorPayoutRoutes } from './domains/creators/payout.routes';
import { registerWebhookRoutes } from './domains/webhooks/webhook.routes';
import { registerAnalyticsRoutes } from './domains/analytics/analytics.routes';
import { registerAdminRoutes } from './domains/admin/admin.routes';
import { registerMetricsRoute } from './routes/metrics.routes';
import redisPool, { startRedisHealthCheck } from './lib/redisPool';
import { setServiceState } from './services/health.service';
import { registerSecurityPlugins } from './plugins/security';
import { registerGraphQL } from './graphql/plugin';
import { registerJobRoutes } from './domains/jobs/jobs.routes';
import { startWorkers } from './lib/workers/index';
import { closeQueues } from './lib/queue';
import { registerApiVersioning } from './plugins/apiVersion';
import { registerRequestLogging } from './plugins/requestLogging';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
  },
});

// Initialize Prisma
const prisma = new PrismaClient();

// Response schemas are documentation-only; see config/serialization.ts.
applyJsonSerializer(app);

// Register plugins
app.register(cors, {
  origin: true,
  credentials: true,
});
app.register(cookie);

app.register(cookie, {
  secret: config.JWT_SECRET,
});

// Register routes
registerAuthRoutes(app, prisma);
registerWalletRoutes(app, prisma);
registerPaymentRoutes(app, prisma);
registerUserRoutes(app, prisma);
registerCreatorPayoutRoutes(app, prisma);
registerWebhookRoutes(app, prisma);
registerAnalyticsRoutes(app, prisma);
registerAdminRoutes(app, prisma);
registerChargeRoutes(app, prisma);
registerMetricsRoute(app, prisma);

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
        status: (redisPool && (redisPool.size ?? 0) > 0) ? 'healthy' : 'degraded',
      },
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
//
// This replaces two separate, competing SIGTERM/SIGINT handlers that used
// to be registered here — both fired on the same signal, both raced to
// call `process.exit()`, and neither called `closeQueues()`, so pending
// BullMQ jobs and their Redis connections were never drained.
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
    app.log.info('HTTP server closed, in-flight requests drained');

    await closeQueues();
    app.log.info('Job queues closed');

    await closeDatabase();
    await prisma.$disconnect();
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
  await app.register(cookie);

  // API versioning (#25): validates an optional API-Version header against
  // SUPPORTED_API_VERSIONS and records per-version usage metrics. Existing
  // /api/v1/... paths are untouched — this only adds header validation and
  // observability.
  registerApiVersioning(app);

  registerAuthRoutes(app, prisma);
  registerWalletRoutes(app, prisma);
  registerPaymentRoutes(app, prisma);
  registerUserRoutes(app, prisma);
  registerCreatorPayoutRoutes(app, prisma);
  registerWebhookRoutes(app, prisma);
  registerAnalyticsRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  registerMetricsRoute(app, prisma);
  registerJobRoutes(app);

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

    if (config.ENABLE_WORKERS) {
      startWorkers().catch((err) => {
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

const handleShutdown = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, starting graceful shutdown...`);
  try {
    await app.close();
    await closeDatabase();
    await prisma.$disconnect();
    await closeQueues().catch(() => undefined);
    app.log.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Background workers are opt-in so the API process does not need to compete for
// Redis connections when a separate worker deployment runs them.
const startBackgroundWorkers = async (): Promise<void> => {
  if (!config.JOBS_WORKERS_ENABLED) return;
  try {
    const { startConfiguredWorkers } = await import('./lib/jobs');
    const workers = startConfiguredWorkers({ deps: { prisma } });
    app.log.info({ workers: workers.length }, 'Background job workers started');
  } catch (err) {
    app.log.error({ err }, 'Failed to start background job workers');
  }
};

void startBackgroundWorkers();

start();

