import { createClient, RedisClientType } from 'redis';
import genericPool from 'generic-pool';
import { config } from '../config';
import { cacheHits, cacheMisses, registerPoolMetrics } from './metrics';

type PooledRedis = RedisClientType;

const factory: genericPool.Factory<PooledRedis> = {
  create: async () => {
    const client: RedisClientType = createClient({ url: config.REDIS_URL });
    client.on('error', (err) => console.error('Redis client error', err));
    await client.connect();
    return client;
  },
  destroy: async (client: PooledRedis) => {
    try {
      await client.quit();
    } catch (err) {
      try {
        await client.disconnect();
      } catch (e) {
        // ignore
      }
    }
  },
};

const opts: genericPool.Options = {
  min: config.REDIS_POOL_MIN,
  max: config.REDIS_POOL_MAX,
  acquireTimeoutMillis: config.REDIS_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: config.REDIS_POOL_IDLE_TIMEOUT_MS,
};

export const redisPool = genericPool.createPool(factory, opts);

let healthTimer: ReturnType<typeof setInterval> | null = null;

export function startRedisHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    try {
      const client = await redisPool.acquire();
      try {
        await client.ping();
      } finally {
        await redisPool.release(client);
      }
    } catch (err) {
      console.error('Redis healthcheck failed', err);
    }
  }, config.REDIS_HEALTHCHECK_INTERVAL_MS);
}

export function stopRedisHealthCheck() {
  if (!healthTimer) return;
  clearInterval(healthTimer);
  healthTimer = null;
}

export async function withRedis<T>(fn: (client: PooledRedis) => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
  try {
    const client = await redisPool.acquire();
    try {
      return await fn(client);
    } finally {
      await redisPool.release(client);
    }
  } catch (err) {
    console.error('Redis operation failed, falling back', err);
    if (fallback) return fallback();
    throw err;
  }
}

// register pool metrics collector
registerPoolMetrics(redisPool);

export default redisPool;
