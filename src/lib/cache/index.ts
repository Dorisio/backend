import { LRUCache } from 'lru-cache';
import { withRedis } from '../redisPool';
import { cacheHits, cacheMisses, cacheSizeGauge, cacheHitRateGauge } from '../metrics';
import { config } from '../../config';

type CacheOptions = { ttlMs?: number; prefix?: string };

export enum CacheType {
  USER = 'user',
  CREATOR = 'creator',
  TRENDING = 'trending',
  ANALYTICS = 'analytics',
}

export const TTL_CONFIG: Record<CacheType, number> = {
  [CacheType.USER]: 5 * 60 * 1000, // 5 minutes
  [CacheType.CREATOR]: 10 * 60 * 1000, // 10 minutes
  [CacheType.TRENDING]: 1 * 60 * 1000, // 1 minute
  [CacheType.ANALYTICS]: 60 * 60 * 1000, // 1 hour
};

const memoryCache = new LRUCache<string, any>({
  max: config.CACHE_FALLBACK_MEMORY_SIZE,
  ttl: 1000 * 60 * 60, // default 1h
});

// Cache statistics
const stats = {
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
  errors: 0,
};

/**
 * Apply probabilistic early expiration jitter (±10%)
 * This prevents thundering herd by spreading out cache expiration times
 */
function applyJitter(ttlMs: number): number {
  const jitter = ttlMs * 0.1; // 10% jitter
  const randomJitter = (Math.random() - 0.5) * 2 * jitter; // -10% to +10%
  return Math.max(ttlMs + randomJitter, ttlMs * 0.5); // Minimum 50% of original TTL
}

/**
 * Get cache hit rate
 */
export function getHitRate(): number {
  const total = stats.hits + stats.misses;
  if (total === 0) return 0;
  return stats.hits / total;
}

/**
 * Get cache statistics
 */
export function getStats() {
  return {
    ...stats,
    hitRate: getHitRate(),
    memorySize: memoryCache.size,
  };
}

/**
 * Reset cache statistics
 */
export function resetStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.sets = 0;
  stats.deletes = 0;
  stats.errors = 0;
}

export async function get(key: string, opts?: CacheOptions): Promise<any> {
  // try redis first
  try {
    return await withRedis(async (client) => {
      const value = await client.get(key);
      if (value == null) {
        stats.misses++;
        cacheMisses.inc();
        updateHitRate();
        return null;
      }
      stats.hits++;
      cacheHits.inc();
      updateHitRate();
      return JSON.parse(value);
    }, async () => {
      const v = memoryCache.get(key) ?? null;
      if (v == null) {
        stats.misses++;
        cacheMisses.inc();
      } else {
        stats.hits++;
        cacheHits.inc();
      }
      cacheSizeGauge.set(memoryCache.size);
      updateHitRate();
      return v;
    });
  } catch (err) {
    stats.errors++;
    // fallback
    const v = memoryCache.get(key) ?? null;
    if (v == null) {
      stats.misses++;
      cacheMisses.inc();
    } else {
      stats.hits++;
      cacheHits.inc();
    }
    cacheSizeGauge.set(memoryCache.size);
    updateHitRate();
    return v;
  }
}

export async function set(key: string, value: any, ttlMs?: number): Promise<void> {
  const s = JSON.stringify(value);
  // Apply jitter to TTL if provided
  const jitteredTtl = ttlMs ? applyJitter(ttlMs) : undefined;
  
  stats.sets++;
  
  // best-effort set to redis with fallback to memory cache
  await withRedis(async (client) => {
    if (jitteredTtl) {
      await client.set(key, s, { PX: jitteredTtl });
    } else {
      await client.set(key, s);
    }
  }, async () => {
    memoryCache.set(key, value, { ttl: ttlMs });
    cacheSizeGauge.set(memoryCache.size);
  });
}

export async function del(key: string): Promise<void> {
  stats.deletes++;
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
  resetStats();
}

export function makeKey(version: string, namespace: string, id: string) {
  return `${version}:${namespace}:${id}`;
}

/**
 * Increment a counter in Redis (for analytics, view counts, etc.)
 */
export async function increment(key: string, amount: number = 1): Promise<number> {
  return await withRedis(async (client) => {
    return await client.incrBy(key, amount);
  }, async () => {
    // Fallback to memory cache for counters
    const current = memoryCache.get(key) || 0;
    const newValue = (current as number) + amount;
    memoryCache.set(key, newValue);
    return newValue;
  });
}

/**
 * Add to a sorted set (for leaderboards, rankings)
 */
export async function zAdd(key: string, score: number, member: string): Promise<number> {
  return await withRedis(async (client) => {
    return await client.zAdd(key, { score, value: member });
  }, async () => {
    // Fallback: not supported in memory cache, return 0
    return 0;
  });
}

/**
 * Get range from sorted set (for leaderboards)
 */
export async function zRange(key: string, start: number, end: number, reverse: boolean = false): Promise<any[]> {
  return await withRedis(async (client) => {
    if (reverse) {
      return await client.zRange(key, start, end, { REV: true });
    }
    return await client.zRange(key, start, end);
  }, async () => {
    // Fallback: return empty array
    return [];
  });
}

/**
 * Get score from sorted set
 */
export async function zScore(key: string, member: string): Promise<number | null> {
  return await withRedis(async (client) => {
    return await client.zScore(key, member);
  }, async () => {
    // Fallback: return null
    return null;
  });
}

/**
 * Update hit rate gauge
 */
function updateHitRate(): void {
  cacheHitRateGauge.set(getHitRate());
}

export default { get, set, del, clear, makeKey, increment, zAdd, zRange, zScore, getStats, getHitRate, resetStats };

// Export the makeKey function as createCacheKey for consistency
export const createCacheKey = makeKey;
