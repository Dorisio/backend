import { createClient, RedisClientType, RedisFunctions, RedisScripts } from 'redis';
import { cacheConfig, CacheConfig } from '../config/cache';

interface CacheMetrics {
  hits: number;
  misses: number;
  errors: number;
  setOps: number;
  getOps: number;
}

export class CacheService {
  private client: RedisClientType<RedisFunctions, RedisScripts> | null = null;
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    errors: 0,
    setOps: 0,
    getOps: 0,
  };
  private isReady: boolean = false;
  private lockTimeout: number = 5000;

  constructor(config?: Partial<CacheConfig>) {
    if (config) {
      Object.assign(cacheConfig, config);
    }
  }

  async connect(): Promise<void> {
    try {
      this.client = createClient({
        socket: {
          host: cacheConfig.host,
          port: cacheConfig.port,
        },
        password: cacheConfig.password,
        database: cacheConfig.db,
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
        this.metrics.errors++;
        this.isReady = false;
      });

      this.client.on('connect', () => {
        this.isReady = true;
      });

      await this.client.connect();
      this.isReady = true;
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      this.isReady = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isReady = false;
    }
  }

  isAvailable(): boolean {
    return this.isReady && this.client !== null;
  }

  private buildKey(key: string): string {
    return `${cacheConfig.keyPrefix}:${cacheConfig.keyVersion}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) {
      this.metrics.misses++;
      return null;
    }

    try {
      this.metrics.getOps++;
      const fullKey = this.buildKey(key);
      const data = await this.client!.get(fullKey);

      if (data === null) {
        this.metrics.misses++;
        return null;
      }

      this.metrics.hits++;
      return JSON.parse(data) as T;
    } catch (error) {
      console.error('Cache get error:', error);
      this.metrics.errors++;
      return null;
    }
  }

  async set<T>(key: string, data: T, ttlSeconds?: number): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      this.metrics.setOps++;
      const fullKey = this.buildKey(key);
      const ttl = ttlSeconds || cacheConfig.defaultTtlSeconds;
      const serialized = JSON.stringify(data);

      await this.client!.set(fullKey, serialized, { EX: ttl });
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async del(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const fullKey = this.buildKey(key);
      await this.client!.del(fullKey);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async invalidatePattern(pattern: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const fullPattern = this.buildKey(pattern);
      let count = 0;
      let cursor = 0;

      do {
        const result = await this.client!.scan(cursor, { MATCH: fullPattern, COUNT: 100 });
        cursor = result.cursor;

        if (result.keys.length > 0) {
          await this.client!.del(...result.keys);
          count += result.keys.length;
        }
      } while (cursor !== 0);

      return count;
    } catch (error) {
      console.error('Cache invalidate pattern error:', error);
      this.metrics.errors++;
      return 0;
    }
  }

  async clearAll(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client!.flushDb();
      return true;
    } catch (error) {
      console.error('Cache clear all error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async getWithLock<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const lockKey = `lock:${key}`;
    const acquired = await this.acquireLock(lockKey);

    if (!acquired) {
      // Wait briefly and retry
      await new Promise((resolve) => setTimeout(resolve, 100));
      const retry = await this.get<T>(key);
      if (retry !== null) {
        return retry;
      }
      this.metrics.misses++;
      return null;
    }

    try {
      const data = await fetchFn();
      await this.set(key, data, ttlSeconds);
      return data;
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  /**
   * Public distributed lock primitive (SET NX EX under the hood) — used
   * internally by getWithLock() and reused directly by
   * src/lib/idempotency.ts (#24) to serialize concurrent requests sharing
   * the same Idempotency-Key.
   */
  async acquireLock(lockKey: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const fullLockKey = this.buildKey(lockKey);
      const result = await this.client!.set(
        fullLockKey,
        'locked',
        { EX: this.lockTimeout / 1000, NX: true }
      );
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async releaseLock(lockKey: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const fullLockKey = this.buildKey(lockKey);
      await this.client!.del(fullLockKey);
    } catch {
      // Ignore release errors
    }
  }

  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      errors: 0,
      setOps: 0,
      getOps: 0,
    };
  }

  async warmup(warmupFn: (batchSize: number) => Promise<string[]>): Promise<void> {
    if (!cacheConfig.warmupEnabled || !this.isAvailable()) {
      return;
    }

    try {
      const keys = await warmupFn(cacheConfig.warmupBatchSize);
      for (const key of keys) {
        await this.del(key);
      }
    } catch (error) {
      console.error('Cache warmup error:', error);
    }
  }
}

export const cacheService = new CacheService();