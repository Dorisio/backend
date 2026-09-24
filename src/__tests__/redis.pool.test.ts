import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { redisPool, startRedisHealthCheck, stopRedisHealthCheck } from '../lib/redisPool';

describe('Redis Pool', () => {
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
