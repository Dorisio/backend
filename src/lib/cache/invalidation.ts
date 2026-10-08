import { createClient, type RedisClientType } from 'redis';
import { config } from '../../config';
import cache, { CacheType } from './index';
import { logger } from '../../utils/logger';

export const CACHE_TTLS_MS = {
  tips: 5 * 60_000,
  creators: 10 * 60_000,
  earnings: 60_000,
  analytics: 5 * 60_000,
} as const;

export type CacheInvalidationReason = 'tip.created' | 'tip.completed' | 'payout.executed' | 'creator.updated' | 'manual';
export interface CacheInvalidationEvent {
  type: 'cache.invalidate';
  keys: string[];
  reason: CacheInvalidationReason;
  timestamp: string;
  source: string;
}

const CHANNEL = 'dorisio:cache:invalidation';
let subscriber: RedisClientType | null = null;
let started = false;

function sourceId(): string {
  return process.env.HOSTNAME ?? `pid-${process.pid}`;
}

export async function invalidateCaches(
  keys: string[],
  reason: CacheInvalidationReason,
  options: { publish?: boolean } = {}
): Promise<void> {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return;
  await Promise.all(uniqueKeys.map((key) => cache.del(key)));
  const event: CacheInvalidationEvent = {
    type: 'cache.invalidate', keys: uniqueKeys, reason, timestamp: new Date().toISOString(), source: sourceId(),
  };
  logger.info({ cacheKeys: uniqueKeys, reason }, 'Cache invalidated');
  if (options.publish !== false) {
    try {
      const publisher = createClient({ url: config.REDIS_URL, socket: { reconnectStrategy: false } });
      await publisher.connect();
      await publisher.publish(CHANNEL, JSON.stringify(event));
      await publisher.quit();
    } catch (error) {
      logger.warn({ error, reason }, 'Unable to publish cache invalidation event');
    }
  }
}

export async function startCacheInvalidationSubscriber(): Promise<void> {
  if (started) return;
  started = true;
  try {
    subscriber = createClient({ url: config.REDIS_URL, socket: { reconnectStrategy: false } });
    subscriber.on('error', (error) => logger.warn({ error }, 'Cache invalidation subscriber error'));
    await subscriber.connect();
    await subscriber.subscribe(CHANNEL, async (payload) => {
      try {
        const event = JSON.parse(payload) as CacheInvalidationEvent;
        if (event.source !== sourceId() && event.type === 'cache.invalidate') {
          await invalidateCaches(event.keys, event.reason, { publish: false });
        }
      } catch (error) {
        logger.warn({ error }, 'Invalid cache invalidation event');
      }
    });
  } catch (error) {
    started = false;
    subscriber = null;
    logger.warn({ error }, 'Cache invalidation subscriber unavailable; local invalidation remains active');
  }
}

export async function stopCacheInvalidationSubscriber(): Promise<void> {
  if (!subscriber) return;
  try { await subscriber.quit(); } finally { subscriber = null; started = false; }
}

export function tipCacheKeys(tipId: string, creatorId?: string): string[] {
  return [
    `v1:tip:${tipId}`,
    ...(creatorId ? [`v1:creator:${creatorId}`, `v1:earnings:${creatorId}`] : []),
    'v1:analytics:tips',
  ];
}

export function creatorCacheKeys(creatorId: string, username?: string): string[] {
  return [`v1:creator:${creatorId}`, `v1:creator:userId:${creatorId}`, ...(username ? [`v1:creator:username:${username}`] : [])];
}

export function earningsCacheKey(creatorId: string): string { return `v1:earnings:${creatorId}`; }

export { CacheType };
