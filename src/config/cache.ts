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
  host: config.REDIS_HOST || '127.0.0.1',
  port: config.REDIS_PORT || 6379,
  password: config.REDIS_PASSWORD || undefined,
  db: config.REDIS_DB || 0,
  keyPrefix: 'app',
  keyVersion: 'v1',
  defaultTtlSeconds: 300,
  warmupEnabled: config.CACHE_WARMUP_ENABLED || config.WARMUP_CACHE,
  warmupBatchSize: 100,
  metricsEnabled: config.CACHE_METRICS_ENABLED || config.ENABLE_CACHE_METRICS,
};
import { config } from './env';
