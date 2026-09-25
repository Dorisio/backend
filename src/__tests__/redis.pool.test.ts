import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from 'redis';
import { redisPool, startRedisHealthCheck, stopRedisHealthCheck } from '../lib/redisPool';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const isRedisAvailable = async (): Promise<boolean> => {
  const client = createClient({
    url: redisUrl,
    socket: {
      timeout: 1000,
      reconnectStrategy: false,
    },
  });

  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.quit();
    } catch {
      // no-op: the Redis client may already be disconnected.
    }
  }
};

const canUseRedis = await isRedisAvailable();

describe.skipIf(!canUseRedis)('Redis Pool', () => {
  it('creates a pool with min and max', async () => {
    expect(redisPool).toBeDefined();
    // pool exposes options
    expect(redisPool.min).toBeDefined();
  });

  it('acquire and release client', async () => {
    const client = await redisPool.acquire();
    expect(client).toBeDefined();
    await redisPool.release(client);
  });

  it('starts and stops health check', () => {
    startRedisHealthCheck();
    stopRedisHealthCheck();
  });
});
