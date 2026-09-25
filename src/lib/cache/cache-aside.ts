import cache, { CacheType, TTL_CONFIG, makeKey } from './index';

// Re-export CacheType for use in other modules
export { CacheType } from './index';
import { logger } from '../../utils/logger';

/**
 * Cache-aside pattern wrapper
 * 
 * This implements the cache-aside pattern where:
 * 1. Application looks up cache first
 * 2. If cache miss, query database
 * 3. Write data to cache for future requests
 * 4. Cache updates happen on write operations
 */

export interface CacheAsideOptions<T> {
  key: string;
  type: CacheType;
  ttlMs?: number;
  fetchFn: () => Promise<T>;
  skipCache?: boolean;
}

/**
 * Get data with cache-aside pattern
 * 
 * @param options - Cache configuration and fetch function
 * @returns Cached or freshly fetched data
 */
export async function getOrFetch<T>(options: CacheAsideOptions<T>): Promise<T> {
  const { key, type, ttlMs, fetchFn, skipCache = false } = options;

  // Skip cache if explicitly requested
  if (skipCache) {
    logger.debug(`Cache skipped for key: ${key}`);
    return await fetchFn();
  }

  try {
    // Try to get from cache
    const cached = await cache.get(key);
    if (cached !== null) {
      logger.debug(`Cache hit for key: ${key}`);
      return cached as T;
    }

    // Cache miss - fetch from source
    logger.debug(`Cache miss for key: ${key}, fetching from source`);
    const data = await fetchFn();

    // Store in cache with appropriate TTL
    const ttl = ttlMs ?? TTL_CONFIG[type];
    await cache.set(key, data, ttl);

    return data;
  } catch (error) {
    logger.error(`Cache-aside error for key: ${key}`, error);
    
    // On cache error, fallback to direct fetch
    try {
      return await fetchFn();
    } catch (fetchError) {
      logger.error(`Fallback fetch failed for key: ${key}`, fetchError);
      throw fetchError;
    }
  }
}

/**
 * Invalidate cache entry
 * 
 * @param key - Cache key to invalidate
 */
export async function invalidate(key: string): Promise<void> {
  try {
    await cache.del(key);
    logger.debug(`Cache invalidated for key: ${key}`);
  } catch (error) {
    logger.error(`Failed to invalidate cache for key: ${key}`, error);
  }
}

/**
 * Invalidate multiple cache entries by pattern
 * 
 * @param pattern - Key pattern to match (e.g., "v1:user:*")
 * Note: This requires Redis SCAN operation, not implemented in basic cache
 */
export async function invalidatePattern(pattern: string): Promise<void> {
  logger.warn(`Pattern-based cache invalidation not implemented for: ${pattern}`);
  // Pattern-based invalidation would require Redis SCAN or KEYS command
  // For now, this is a placeholder for future implementation
}

/**
 * Update cache entry with new data
 * 
 * @param key - Cache key
 * @param data - New data to cache
 * @param type - Cache type for TTL
 * @param ttlMs - Optional custom TTL
 */
export async function update<T>(
  key: string,
  data: T,
  type: CacheType,
  ttlMs?: number
): Promise<void> {
  try {
    const ttl = ttlMs ?? TTL_CONFIG[type];
    await cache.set(key, data, ttl);
    logger.debug(`Cache updated for key: ${key}`);
  } catch (error) {
    logger.error(`Failed to update cache for key: ${key}`, error);
  }
}

/**
 * Create a cache key with proper versioning
 * 
 * @param type - Cache type
 * @param id - Resource identifier
 * @param version - Cache version (default: v1)
 */
export function createCacheKey(type: CacheType, id: string, version: string = 'v1'): string {
  return makeKey(version, type, id);
}

/**
 * Batch cache operations for multiple keys
 */
export async function batchGetOrFetch<T>(
  operations: CacheAsideOptions<T>[]
): Promise<T[]> {
  return Promise.all(operations.map(op => getOrFetch(op)));
}

/**
 * Cache decorator for service methods
 * 
 * Usage:
 * ```ts
 * class MyService {
 *   @Cacheable({ type: CacheType.USER, keyPrefix: 'user' })
 *   async getUser(userId: string) {
 *     return this.prisma.user.findUnique({ where: { id: userId } });
 *   }
 * }
 * ```
 * 
 * Note: This is a simplified version. For full decorator support,
 * consider using a library like cache-manager or implementing
 * a more sophisticated decorator system.
 */
export function Cacheable(options: {
  type: CacheType;
  keyPrefix: string;
  ttlMs?: number;
}) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const key = createCacheKey(options.type, `${options.keyPrefix}:${args[0]}`);
      
      return getOrFetch({
        key,
        type: options.type,
        ttlMs: options.ttlMs,
        fetchFn: () => originalMethod.apply(this, args),
      });
    };

    return descriptor;
  };
}
