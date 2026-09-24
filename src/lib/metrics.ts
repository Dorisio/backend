import { register, Counter, Gauge, Histogram } from 'prom-client';
import { PrismaClient } from '@prisma/client';
import type { Pool } from 'generic-pool';

// Initialize Prometheus metrics
export const metricsRegister = register;

// Counters
export const tipCounter = new Counter({
  name: 'dorisio_tips_total',
  help: 'Total number of tips created',
  labelNames: ['status'],
});

export const paymentCounter = new Counter({
  name: 'dorisio_payments_total',
  help: 'Total number of Stellar transactions submitted',
  labelNames: ['status'],
});

export const webhookCounter = new Counter({
  name: 'dorisio_webhooks_total',
  help: 'Total webhook dispatch attempts',
  labelNames: ['event_type', 'status'],
});

export const authCounter = new Counter({
  name: 'dorisio_auth_total',
  help: 'Total authentication attempts',
  labelNames: ['type', 'status'],
});

// Gauges
export const activeTipsGauge = new Gauge({
  name: 'dorisio_active_tips',
  help: 'Number of tips currently pending',
});

export const confirmedTipsGauge = new Gauge({
  name: 'dorisio_confirmed_tips_total',
  help: 'Total confirmed tips',
});

export const usersGauge = new Gauge({
  name: 'dorisio_users_total',
  help: 'Total registered users',
});

export const creatorsGauge = new Gauge({
  name: 'dorisio_creators_total',
  help: 'Total registered creators',
});

export const queueLengthGauge = new Gauge({
  name: 'dorisio_queue_length',
  help: 'Length of job queues',
  labelNames: ['queue_name'],
});

export const totalEarningsGauge = new Gauge({
  name: 'dorisio_total_earnings_usd',
  help: 'Total earnings across all creators',
});

// Histograms
export const requestDurationHistogram = new Histogram({
  name: 'dorisio_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Cache metrics
export const cacheHits = new Counter({
  name: 'dorisio_cache_hits_total',
  help: 'Total cache hits',
});

export const cacheMisses = new Counter({
  name: 'dorisio_cache_misses_total',
  help: 'Total cache misses',
});

export const cacheSizeGauge = new Gauge({
  name: 'dorisio_cache_size',
  help: 'Current in-memory fallback cache size',
});

export function registerPoolMetrics(pool: Pool<any>) {
  // Expose pool stats via gauges
  const poolUsed = new Gauge({ name: 'dorisio_redis_pool_used', help: 'Number of used connections' });
  const poolWaiting = new Gauge({ name: 'dorisio_redis_pool_waiting', help: 'Number of waiting acquires' });
  const poolSize = new Gauge({ name: 'dorisio_redis_pool_size', help: 'Total pool size' });

  setInterval(() => {
    try {
      // generic-pool exposes these properties at runtime
      poolUsed.set((pool as any).borrowed || (pool as any).pending || 0);
      poolWaiting.set((pool as any).pending || 0);
      poolSize.set((pool as any).size || 0);
    } catch (e) {
      // ignore
    }
  }, 5000);
}

export const dbQueryDurationHistogram = new Histogram({
  name: 'dorisio_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'model'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
});

export const webhookLatencyHistogram = new Histogram({
  name: 'dorisio_webhook_latency_seconds',
  help: 'Webhook dispatch latency in seconds',
  labelNames: ['event_type'],
  buckets: [0.5, 1, 2, 5, 10, 30],
});

/**
 * Update metrics from database
 */
export async function updateMetrics(prisma: PrismaClient): Promise<void> {
  try {
    // Get counts
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

    activeTipsGauge.set(pendingTips);
    confirmedTipsGauge.set(confirmedTips);
    usersGauge.set(users);
    creatorsGauge.set(creators);
    totalEarningsGauge.set(totalEarnings._sum.amount || 0);
  } catch (error) {
    console.error('Error updating metrics:', error);
  }
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetricsText(): Promise<string> {
  return metricsRegister.metrics();
}
