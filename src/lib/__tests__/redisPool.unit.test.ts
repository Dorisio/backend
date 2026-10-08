import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRedisPool,
  getRedisPoolStats,
  redisPool,
  startRedisHealthCheck,
  stopRedisHealthCheck,
  withRedis,
} from '../redisPool';

describe('shared Redis short-command pool', () => {
  afterEach(() => {
    stopRedisHealthCheck();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exposes typed runtime pool stats', () => {
    const stats = getRedisPoolStats();

    expect(stats).toEqual(expect.objectContaining({
      size: expect.any(Number),
      available: expect.any(Number),
      borrowed: expect.any(Number),
      pending: expect.any(Number),
      min: expect.any(Number),
      max: expect.any(Number),
    }));
  });

  it('uses the fallback when acquiring a client fails', async () => {
    vi.spyOn(redisPool, 'acquire').mockRejectedValue(new Error('Redis unavailable'));
    const fallback = vi.fn().mockResolvedValue('memory-value');

    await expect(withRedis(async () => 'redis-value', fallback)).resolves.toBe('memory-value');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('destroys a client when its command fails instead of returning it', async () => {
    const client = { isOpen: true, isReady: true } as any;
    const acquire = vi.spyOn(redisPool, 'acquire').mockResolvedValue(client);
    const release = vi.spyOn(redisPool, 'release').mockResolvedValue();
    const destroy = vi.spyOn(redisPool, 'destroy').mockResolvedValue();

    await expect(withRedis(async () => {
      throw new Error('broken connection');
    })).rejects.toThrow('broken connection');

    expect(acquire).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(client);
    expect(release).not.toHaveBeenCalled();
  });

  it('does not install overlapping health-check timers', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    startRedisHealthCheck();
    startRedisHealthCheck();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    stopRedisHealthCheck();
  });

  it('drains and clears the pool only once on repeated close calls', async () => {
    const drain = vi.spyOn(redisPool, 'drain').mockResolvedValue();
    const clear = vi.spyOn(redisPool, 'clear').mockResolvedValue();

    await closeRedisPool();
    await closeRedisPool();

    expect(drain).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });
});
