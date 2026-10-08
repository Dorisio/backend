import { cacheConfig, CacheConfig } from '../config/cache';
import { withRedis } from './redisPool';

interface CacheMetrics {
  hits: number;
  misses: number;
  errors: number;
  setOps: number;
  getOps: number;
}

interface MemoryEntry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * CacheService is a small namespaced facade over the shared short-command
 * pool. The local map remains a best-effort fallback, so cache outages never
 * turn into request failures.
 */
export class CacheService {
  private metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    errors: 0,
    setOps: 0,
    getOps: 0,
  };
  private readonly memory = new Map<string, MemoryEntry>();
  private isReady = false;
  private lockTimeout = 5000;

  constructor(config?: Partial<CacheConfig>) {
    if (config) Object.assign(cacheConfig, config);
  }

  /**
   * Preserve the old explicit lifecycle API. The shared pool itself is lazy;
   * connecting here simply verifies that one pooled client is usable.
   */
  async connect(): Promise<void> {
    try {
      await withRedis(async (client) => {
        await client.ping();
      });
      this.isReady = true;
    } catch (error) {
      this.isReady = false;
      throw error;
    }
  }

  /** Disconnect this facade without tearing down the process-wide pool. */
  async disconnect(): Promise<void> {
    this.isReady = false;
  }

  isAvailable(): boolean {
    return this.isReady;
  }

  private buildKey(key: string): string {
    return `${cacheConfig.keyPrefix}:${cacheConfig.keyVersion}:${key}`;
  }

  private memoryGet<T>(key: string): T | null {
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private memorySet(key: string, value: unknown, ttlSeconds?: number): void {
    this.memory.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    this.metrics.getOps++;
    const fullKey = this.buildKey(key);
    const redisFallback = async (): Promise<string | null> => {
      const value = this.memoryGet<T>(key);
      return value === null ? null : JSON.stringify(value);
    };

    try {
      let data: string | null;
      if (!this.isReady) {
        return this.memoryGet<T>(key);
      }
      data = await withRedis<string | null>((client) => client.get(fullKey), redisFallback);
      if (data === null) {
        this.metrics.misses++;
        return null;
      }
      const value = JSON.parse(data) as T;
      this.metrics.hits++;
      return value;
    } catch (error) {
      console.error('Cache get error:', error);
      this.metrics.errors++;
      this.metrics.misses++;
      return this.memoryGet<T>(key);
    }
  }

  async set<T>(key: string, data: T, ttlSeconds?: number): Promise<boolean> {
    this.metrics.setOps++;
    const fullKey = this.buildKey(key);
    const ttl = ttlSeconds ?? cacheConfig.defaultTtlSeconds;
    const serialized = JSON.stringify(data);
    const fallback = async () => {
      this.memorySet(key, data, ttl);
      return true;
    };

    try {
      if (!this.isReady) return fallback();
      await withRedis<boolean>(async (client) => {
        await client.set(fullKey, serialized, { EX: ttl });
        return true;
      }, fallback);
      return true;
    } catch (error) {
      console.error('Cache set error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async del(key: string): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const fallback = async () => {
      this.memory.delete(key);
      return true;
    };
    try {
      if (!this.isReady) return fallback();
      await withRedis<boolean>(async (client) => {
        await client.del(fullKey);
        return true;
      }, fallback);
      return true;
    } catch (error) {
      console.error('Cache delete error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async invalidatePattern(pattern: string): Promise<number> {
    const fullPattern = this.buildKey(pattern);
    const fallback = async () => {
      let count = 0;
      for (const key of this.memory.keys()) {
        if (key === pattern || key.startsWith(pattern.replace('*', ''))) {
          this.memory.delete(key);
          count++;
        }
      }
      return count;
    };
    try {
      if (!this.isReady) return fallback();
      return await withRedis(async (client) => {
        let count = 0;
        let cursor = 0;
        do {
          const result = await client.scan(cursor, { MATCH: fullPattern, COUNT: 100 });
          cursor = Number(result.cursor);
          if (result.keys.length > 0) {
            await client.del(result.keys);
            count += result.keys.length;
          }
        } while (cursor !== 0);
        return count;
      }, fallback);
    } catch (error) {
      console.error('Cache invalidate pattern error:', error);
      this.metrics.errors++;
      return fallback();
    }
  }

  async clearAll(): Promise<boolean> {
    const fallback = async () => {
      this.memory.clear();
      return true;
    };
    try {
      if (!this.isReady) return fallback();
      await withRedis<boolean>(async (client) => {
        await client.flushDb();
        return true;
      }, fallback);
      return true;
    } catch (error) {
      console.error('Cache clear all error:', error);
      this.metrics.errors++;
      return false;
    }
  }

  async getWithLock<T>(key: string, fetchFn: () => Promise<T>, ttlSeconds?: number): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const lockKey = `lock:${key}`;
    const acquired = await this.acquireLock(lockKey);
    if (!acquired) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return this.get<T>(key);
    }

    try {
      const data = await fetchFn();
      await this.set(key, data, ttlSeconds);
      return data;
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  async acquireLock(lockKey: string): Promise<boolean> {
    if (!this.isReady) return false;
    try {
      const result = await withRedis<string | null>((client) => client.set(this.buildKey(lockKey), 'locked', {
        EX: this.lockTimeout / 1000,
        NX: true,
      }));
      return result === 'OK';
    } catch {
      return false;
    }
  }

  async releaseLock(lockKey: string): Promise<void> {
    if (!this.isReady) return;
    try {
      await withRedis((client) => client.del(this.buildKey(lockKey)));
    } catch {
      // Lock release is best effort.
    }
  }

  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = { hits: 0, misses: 0, errors: 0, setOps: 0, getOps: 0 };
  }

  async warmup(warmupFn: (batchSize: number) => Promise<string[]>): Promise<void> {
    if (!cacheConfig.warmupEnabled || !this.isAvailable()) return;
    try {
      const keys = await warmupFn(cacheConfig.warmupBatchSize);
      for (const key of keys) await this.del(key);
    } catch (error) {
      console.error('Cache warmup error:', error);
    }
  }
}

export const cacheService = new CacheService();
export default cacheService;
