import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config/env';
import { swaggerConfig } from './config/swagger';
import { requestDurationHistogram } from './lib/metrics';
import { runWithRequestId } from './utils/request-context';
import { AppError } from './utils/errors';
import { PrismaClient } from '@prisma/client';
import { initializeDatabase, closeDatabase, checkDatabaseHealth, getPoolMetrics, getCircuitBreaker } from './db';
import { registerAuthRoutes } from './domains/auth/auth.routes';
import { registerWalletRoutes } from './domains/auth/wallet.routes';
import { registerPaymentRoutes } from './domains/payments/payment.routes';
import { registerUserRoutes } from './domains/users/user.routes';
import { registerCreatorPayoutRoutes } from './domains/creators/payout.routes';
import { registerWebhookRoutes } from './domains/webhooks/webhook.routes';
import { registerAnalyticsRoutes } from './domains/analytics/analytics.routes';
import { registerAdminRoutes } from './domains/admin/admin.routes';
import { registerNotificationRoutes } from './domains/notifications/notification.routes';
import { registerMetricsRoute } from './routes/metrics.routes';
import { closeQueues } from './lib/queue';
import redisPool from './lib/redisPool';
import { emailNotificationWorker } from './lib/workers/email-notification.worker';
import { setServiceState } from './services/health.service';

const app = Fastify({
  genReqId: (request) => {
    const incoming = request.headers['x-request-id'];
    return typeof incoming === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();
  },
  logger: {
    level: config.LOG_LEVEL,
  },
});

// Initialize Prisma
const prisma = new PrismaClient();

// Register plugins
app.register(swagger, { swagger: swaggerConfig.swagger as any });
app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });
app.register(cors, {
  origin: true,
  credentials: true,
});

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('x-request-id', request.id);
  return payload;
});

const requestStartTimes = new WeakMap<object, number>();
app.addHook('onRequest', (request, _reply, done) => {
  requestStartTimes.set(request, performance.now());
  runWithRequestId(request.id, done);
});
app.addHook('onResponse', (request, reply, done) => {
  const startedAt = requestStartTimes.get(request);
  if (startedAt !== undefined) {
    requestDurationHistogram.observe({
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: String(reply.statusCode),
    }, (performance.now() - startedAt) / 1000);
    requestStartTimes.delete(request);
  }
  done();
});

app.get('/api-spec.json', async () => app.swagger());

// Register routes
registerAuthRoutes(app, prisma);
registerWalletRoutes(app, prisma);
registerPaymentRoutes(app, prisma);
registerUserRoutes(app, prisma);
registerCreatorPayoutRoutes(app, prisma);
registerWebhookRoutes(app, prisma);
registerAnalyticsRoutes(app, prisma);
registerAdminRoutes(app, prisma);
registerNotificationRoutes(app, prisma);
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

// Error handler
app.setErrorHandler(async (error, _request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (error instanceof AppError) {
    reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
    });
    return;
  }

  app.log.error(error);
  reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

// Service becomes "ready" only once Fastify has finished booting (all
// plugins/routes registered) - readiness stays 503 until this fires, so
// load balancers don't route traffic before the process can serve it.
app.addHook('onReady', async () => {
  setServiceState('ready');
});

// Graceful shutdown: flip readiness to `shutting_down` first so the
// readiness probe starts failing immediately (giving the load balancer a
// chance to drain traffic away from this instance), then close the
// Fastify server and its dependencies before the process exits.
let shuttingDown = false;

const shutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Received ${signal}, starting graceful shutdown`);
  setServiceState('shutting_down');

  try {
    await app.close();
    await emailNotificationWorker.close();
    await closeQueues();
    await closeDatabase();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
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

const start = async (): Promise<void> => {
  try {
    if (config.DATABASE_URL) {
      try {
        await initializeDatabase();
      } catch (dbErr) {
        app.log.warn({ dbErr }, 'Database pool initialization warning, continuing startup');
      }
    }

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

