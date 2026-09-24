import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/env';
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
import { registerMetricsRoute } from './routes/metrics.routes';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
  },
});

// Initialize Prisma
const prisma = new PrismaClient();

// Register plugins
app.register(cors, {
  origin: true,
  credentials: true,
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

const handleShutdown = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, starting graceful shutdown...`);
  try {
    await app.close();
    await closeDatabase();
    await prisma.$disconnect();
    app.log.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

start();

