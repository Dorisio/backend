export interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  keyVersion: string;
  defaultTtlSeconds: number;
  warmupEnabled: boolean;
  warmupBatchSize: number;
  metricsEnabled: boolean;
}

export const cacheConfig: CacheConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  keyPrefix: 'app',
  keyVersion: 'v1',
  defaultTtlSeconds: 300,
  warmupEnabled: process.env.WARMUP_CACHE === 'true',
  warmupBatchSize: 100,
  metricsEnabled: process.env.ENABLE_CACHE_METRICS === 'true',
};