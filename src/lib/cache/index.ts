import { LRUCache } from 'lru-cache';
import { withRedis } from '../redisPool';
import { cacheHits, cacheMisses, cacheSizeGauge } from '../metrics';
import { config } from '../../config';

type CacheOptions = { ttlMs?: number; prefix?: string };

const memoryCache = new LRUCache<string, any>({
  max: config.CACHE_FALLBACK_MEMORY_SIZE,
  ttl: 1000 * 60 * 60, // default 1h
});

export async function get(key: string, opts?: CacheOptions): Promise<any> {
  // try redis first
  try {
    return await withRedis(async (client) => {
      const value = await client.get(key);
      if (value == null) {
        cacheMisses.inc();
        return null;
      }
      cacheHits.inc();
      return JSON.parse(value);
    }, async () => {
      const v = memoryCache.get(key) ?? null;
      if (v == null) cacheMisses.inc(); else cacheHits.inc();
      cacheSizeGauge.set(memoryCache.size);
      return v;
    });
  } catch (err) {
    // fallback
    const v = memoryCache.get(key) ?? null;
    if (v == null) cacheMisses.inc(); else cacheHits.inc();
    cacheSizeGauge.set(memoryCache.size);
    return v;
  }
}

export async function set(key: string, value: any, ttlMs?: number): Promise<void> {
  const s = JSON.stringify(value);
  // best-effort set to redis with fallback to memory cache
  await withRedis(async (client) => {
    if (ttlMs) {
      await client.set(key, s, { PX: ttlMs });
    } else {
      await client.set(key, s);
    }
  }, async () => {
    memoryCache.set(key, value, { ttl: ttlMs });
    cacheSizeGauge.set(memoryCache.size);
  });
}

export async function del(key: string): Promise<void> {
  await withRedis(async (client) => {
    await client.del(key);
  }, async () => {
    memoryCache.delete(key);
    cacheSizeGauge.set(memoryCache.size);
  });
}

export async function clear(): Promise<void> {
  await withRedis(async (client) => {
    // FLUSHDB is dangerous in shared environments — prefer keyspace versioning. Provided for manual clearing.
    await client.flushDb();
  }, async () => {
    memoryCache.clear();
    cacheSizeGauge.set(memoryCache.size);
  });
}

export function makeKey(version: string, namespace: string, id: string) {
  return `${version}:${namespace}:${id}`;
}

export default { get, set, del, clear, makeKey };
