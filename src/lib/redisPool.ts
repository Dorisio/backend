import { createClient, type RedisClientType } from 'redis';
import genericPool, { type Pool, type Factory, type Options } from 'generic-pool';
import { config } from '../config';
import { registerPoolMetrics } from './metrics';

/** The Redis client shared by short, request-scoped commands. */
export type PooledRedis = ReturnType<typeof createClient>;

/** A stable, typed snapshot of the pool's runtime state. */
export interface RedisPoolStats {
  size: number;
  available: number;
  borrowed: number;
  pending: number;
  min: number;
  max: number;
}

const acquireTimeoutMillis = Math.min(config.REDIS_CONNECTION_TIMEOUT_MS, 3_000);

export const redisPoolOptions: Options = {
  min: config.REDIS_POOL_MIN,
  max: config.REDIS_POOL_MAX,
  // Never let a request wait for the full connection timeout. Redis is a
  // best-effort layer and callers have an explicit fallback path.
  acquireTimeoutMillis,
  idleTimeoutMillis: config.REDIS_POOL_IDLE_TIMEOUT_MS,
  // generic-pool only evicts idle resources when an eviction run is enabled.
  evictionRunIntervalMillis: Math.max(1_000, Math.min(config.REDIS_POOL_IDLE_TIMEOUT_MS || 30_000, 30_000)),
  numTestsPerEvictionRun: Math.max(1, config.REDIS_POOL_MAX),
  testOnBorrow: true,
};

export const redisPoolFactory: Factory<PooledRedis> = {
  create: async () => {
    const client = createClient({
      url: config.REDIS_URL,
      socket: {
        timeout: acquireTimeoutMillis,
        reconnectStrategy: false,
      },
    });
    client.on('error', (err) => console.error('Redis client error', err));
    await client.connect();
    return client;
  },
  // A failed operation is never returned to the available queue. Keep this
  // defensive because quit() can itself fail for an already-broken socket.
  destroy: async (client) => {
    try {
      if (client.isOpen) await client.quit();
    } catch {
      try {
        client.disconnect();
      } catch {
        // The client is already unusable; there is nothing left to clean up.
      }
    }
  },
  // This is deliberately a cheap check. Operation failures are handled by
  // withRedis(), which destroys the exact client that failed.
  validate: async (client) => client.isReady && client.isOpen,
};

export const redisPool: Pool<PooledRedis> = genericPool.createPool(redisPoolFactory, redisPoolOptions);

let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckInFlight = false;
let poolClosed = false;

export function getRedisPoolStats(): RedisPoolStats {
  return {
    size: redisPool.size,
    available: redisPool.available,
    borrowed: redisPool.borrowed,
    pending: redisPool.pending,
    min: redisPool.min,
    max: redisPool.max,
  };
}

/** Backwards-friendly short name for callers that only need pool telemetry. */
export const getPoolStats = getRedisPoolStats;

async function runHealthCheck(): Promise<void> {
  // setInterval can fire again while a slow acquire/ping is still pending.
  if (healthCheckInFlight || poolClosed) return;
  healthCheckInFlight = true;
  let client: PooledRedis | undefined;
  try {
    client = await redisPool.acquire();
    await client.ping();
    await redisPool.release(client);
    client = undefined;
  } catch (err) {
    if (client) {
      try {
        await redisPool.destroy(client);
      } catch {
        // The pool may already be draining during shutdown.
      }
    }
    console.error('Redis healthcheck failed', err);
  } finally {
    healthCheckInFlight = false;
  }
}

export function startRedisHealthCheck(): void {
  if (healthTimer || poolClosed) return;
  healthTimer = setInterval(() => {
    void runHealthCheck();
  }, config.REDIS_HEALTHCHECK_INTERVAL_MS);
  // Timers must not keep a CLI/test process alive on their own.
  healthTimer.unref?.();
}

export function stopRedisHealthCheck(): void {
  if (!healthTimer) return;
  clearInterval(healthTimer);
  healthTimer = null;
}

/**
 * Run one short Redis command and always release or destroy its resource.
 * If acquisition or the command fails, the optional fallback is invoked.
 */
export async function withRedis<T>(
  fn: (client: PooledRedis) => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T> {
  let client: PooledRedis | undefined;
  try {
    client = await redisPool.acquire();
    try {
      const result = await fn(client);
      await redisPool.release(client);
      client = undefined;
      return result;
    } catch (err) {
      // Never release a client after an operation error: it may have a broken
      // socket and would poison the pool for the next request.
      try {
        await redisPool.destroy(client);
      } catch {
        // Preserve the original command error and still allow fallback.
      }
      client = undefined;
      throw err;
    }
  } catch (err) {
    console.error('Redis operation failed, falling back', err);
    if (fallback) return fallback();
    throw err;
  }
}

/** Stop health checks and drain every client. Safe to call repeatedly. */
export async function closeRedisPool(): Promise<void> {
  stopRedisHealthCheck();
  if (poolClosed) return;
  poolClosed = true;
  try {
    await redisPool.drain();
    await redisPool.clear();
  } catch (err) {
    // Shutdown should be best effort and idempotent, but surface diagnostics.
    console.error('Redis pool shutdown failed', err);
  }
}

/** Alias used by application shutdown handlers. */
export const shutdownRedisPool = closeRedisPool;

registerPoolMetrics(redisPool);

export default redisPool;
