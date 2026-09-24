import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getMetricsText, updateMetrics } from '../lib/metrics';
import { getPoolMetrics, getCircuitBreaker } from '../db';

export const registerMetricsRoute = (app: FastifyInstance, prisma: PrismaClient): void => {
  // GET /metrics - Prometheus metrics endpoint
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['Metrics'],
        summary: 'Prometheus metrics endpoint',
        description: 'Get application metrics in Prometheus format for monitoring and alerting.',
        response: {
          200: { description: 'Prometheus metrics' },
        },
      },
    },
    async (_request, reply) => {
      try {
        // Update metrics from database
        await updateMetrics(prisma);
        getPoolMetrics();

        const metrics = await getMetricsText();
        reply.type('text/plain; charset=utf-8').send(metrics);
      } catch (error) {
        app.log.error({ error }, 'Error generating metrics');
        reply.code(500).send('Error generating metrics');
      }
    }
  );

  // GET /metrics/json - JSON metrics endpoint (alternative)
  app.get(
    '/metrics/json',
    {
      schema: {
        tags: ['Metrics'],
        summary: 'Metrics endpoint (JSON format)',
        description: 'Get application metrics in JSON format.',
        response: {
          200: { description: 'JSON metrics' },
        },
      },
    },
    async (_request, reply) => {
      try {
        // Update metrics from database
        await updateMetrics(prisma);
        const poolMetrics = getPoolMetrics();
        const cbMetrics = getCircuitBreaker().getMetrics();

        // Get current metric values
        const [pendingTips, confirmedTips, users, creators, totalEarnings] = await Promise.all([
          prisma.tip.count({ where: { status: 'pending' } }),
          prisma.tip.count({ where: { status: 'confirmed' } }),
          prisma.user.count(),
          prisma.creator.count(),
          prisma.tip.aggregate({
            where: { status: 'confirmed' },
            _sum: { amount: true },
          }),
        ]);

        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        reply.send({
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptime_seconds: Math.round(uptime),
          memory_usage_mb: Math.round((memoryUsage.heapUsed / 1024 / 1024) * 100) / 100,
          memory_total_mb: Math.round((memoryUsage.heapTotal / 1024 / 1024) * 100) / 100,
          database_pool: {
            total_connections: poolMetrics.totalCount,
            active_connections: poolMetrics.activeCount,
            idle_connections: poolMetrics.idleCount,
            waiting_clients: poolMetrics.waitingCount,
            circuit_breaker: cbMetrics,
          },
          application: {
            pending_tips: pendingTips,
            confirmed_tips: confirmedTips,
            total_users: users,
            total_creators: creators,
            total_earnings_usd: Math.round((totalEarnings._sum.amount || 0) * 100) / 100,
          },
        });
      } catch (error) {
        app.log.error({ error }, 'Error generating JSON metrics');
        reply.code(500).send({ error: 'Error generating metrics' });
      }
    }
  );
};
