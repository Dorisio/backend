/**
 * BullMQ queues and shared Redis connections.
 *
 * Single coherent module (re-merged after a bad merge left two generations of
 * this file interleaved). Consumers:
 *
 * - `emailNotificationQueue` / `emailNotificationRedis` — email notifications
 *   (`src/domains/notifications/email.ts`,
 *   `src/lib/workers/email-notification.worker.ts`).
 * - First-class job queues named in `QUEUE_NAMES` — the generic jobs layer
 *   (`src/lib/jobs`), the jobs API (`src/domains/jobs/jobs.routes.ts`) and
 *   queue-health reporting.
 * - `backoffStrategy` + `RETRY_DELAYS_MS` — the documented retry schedule
 *   (issue #27), asserted by `src/lib/__tests__/queue.test.ts`.
 * - `moveToDeadLetter` / `deadLetterQueue` — dead-letter handling shared by
 *   every worker.
 *
 * Connections are created lazily where possible and never connect eagerly:
 * BullMQ opens connections on first use, so importing this module in tests
 * without Redis is safe.
 */
import { Queue, QueueEvents, type ConnectionOptions, type JobsOptions } from 'bullmq';
import IORedis, { type Redis as RedisClient } from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/** BullMQ connection shared by every first-class queue. */
export const bullConnection: ConnectionOptions = {
  url: config.REDIS_URL,
  maxRetriesPerRequest: null,
};

/** Shared ioredis client used by queues that need a live connection object. */
export const redis: RedisClient = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 500, 10_000),
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error (job queues)');
});

/** Priority: higher number = processed first. */
export const JobPriority = {
  low: 1,
  normal: 5,
  high: 10,
} as const;
export type JobPriorityName = keyof typeof JobPriority;

/** Retry delays: 5s, 30s, 5min, 30min, 24h (Issue #27). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000, 86_400_000] as const;

/**
 * Custom backoff strategy mapping attempt number → delay from
 * `RETRY_DELAYS_MS`, clamped to the last entry. Passed to BullMQ workers via
 * `settings.backoffStrategy`.
 */
export function backoffStrategy(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 1) - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

export const defaultJobOptions: JobsOptions = {
  attempts: RETRY_DELAYS_MS.length,
  backoff: {
    type: 'custom',
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: false, // keep for DLQ inspection
  priority: JobPriority.normal,
};

export const QUEUE_NAMES = {
  stellarConfirmation: 'stellar-confirmation',
  webhookDispatch: 'webhook-dispatch',
  email: 'email',
  imageProcessing: 'image-processing',
  analytics: 'analytics',
  exports: 'exports',
  deadLetter: 'dead-letter',
  emailNotifications: 'email-notifications',
} as const;

function createQueue(name: string, connection: ConnectionOptions | RedisClient): Queue {
  return new Queue(name, {
    connection: connection as ConnectionOptions,
    defaultJobOptions,
  });
}

// ── First-class queues (generic jobs layer) ──────────────────────────────────
export const stellarConfirmationQueue = createQueue(
  QUEUE_NAMES.stellarConfirmation,
  bullConnection
);
export const webhookDispatchQueue = createQueue(QUEUE_NAMES.webhookDispatch, bullConnection);
export const emailQueue = createQueue(QUEUE_NAMES.email, bullConnection);
export const imageProcessingQueue = createQueue(QUEUE_NAMES.imageProcessing, bullConnection);
export const analyticsQueue = createQueue(QUEUE_NAMES.analytics, bullConnection);
export const exportsQueue = createQueue(QUEUE_NAMES.exports, bullConnection);
export const deadLetterQueue = createQueue(QUEUE_NAMES.deadLetter, bullConnection);

export const allQueues = [
  stellarConfirmationQueue,
  webhookDispatchQueue,
  emailQueue,
  imageProcessingQueue,
  analyticsQueue,
  exportsQueue,
  deadLetterQueue,
];

// ── Email notification queue (dedicated connection) ─────────────────────────
export const emailNotificationRedis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});
export const emailNotificationEventsRedis = emailNotificationRedis.duplicate();
export const emailNotificationQueue = new Queue(QUEUE_NAMES.emailNotifications, {
  connection: emailNotificationRedis as unknown as ConnectionOptions,
});

function attachEvents(name: string, connection: ConnectionOptions | RedisClient): QueueEvents {
  const events = new QueueEvents(name, { connection: connection as ConnectionOptions });
  events.on('completed', ({ jobId }) => logger.info({ queue: name, jobId }, 'job completed'));
  events.on('failed', ({ jobId, failedReason }) =>
    logger.error({ queue: name, jobId, failedReason }, 'job failed')
  );
  events.on('progress', ({ jobId, data }) =>
    logger.debug({ queue: name, jobId, data }, 'job progress')
  );
  return events;
}

export const stellarConfirmationEvents = attachEvents(
  QUEUE_NAMES.stellarConfirmation,
  bullConnection
);
export const webhookDispatchEvents = attachEvents(QUEUE_NAMES.webhookDispatch, bullConnection);
export const emailEvents = attachEvents(QUEUE_NAMES.email, bullConnection);
export const imageProcessingEvents = attachEvents(QUEUE_NAMES.imageProcessing, bullConnection);
export const analyticsEvents = attachEvents(QUEUE_NAMES.analytics, bullConnection);
export const exportsEvents = attachEvents(QUEUE_NAMES.exports, bullConnection);
export const emailNotificationEvents = attachEvents(
  QUEUE_NAMES.emailNotifications,
  emailNotificationEventsRedis
);

/** Maps a priority name to the BullMQ priority number (higher = sooner). */
export function priorityValue(name: JobPriorityName = 'normal'): number {
  return JobPriority[name];
}

export async function moveToDeadLetter(
  sourceQueue: string,
  jobId: string,
  payload: unknown,
  failedReason: string
): Promise<void> {
  await deadLetterQueue.add(
    'failed-job',
    {
      sourceQueue,
      originalJobId: jobId,
      payload,
      failedReason,
      failedAt: new Date().toISOString(),
    },
    { removeOnComplete: false, removeOnFail: false }
  );
  logger.warn({ sourceQueue, jobId, failedReason }, 'job moved to dead-letter queue');
}

export async function getQueueHealth() {
  const report = [];
  for (const q of allQueues) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    report.push({
      name: q.name,
      waiting,
      active,
      completed,
      failed,
      delayed,
      depth: waiting + active + delayed,
    });
  }
  return report;
}

emailNotificationEvents.on('completed', ({ jobId }) => {
  logger.info({ jobId }, 'Email notification delivered');
});
emailNotificationEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, 'Email notification delivery failed');
});

/** Closes every queue, event listener and dedicated Redis connection. */
export async function closeQueues(): Promise<void> {
  const queues = [
    stellarConfirmationQueue,
    webhookDispatchQueue,
    emailQueue,
    imageProcessingQueue,
    analyticsQueue,
    exportsQueue,
    deadLetterQueue,
    emailNotificationQueue,
  ];
  const events = [
    stellarConfirmationEvents,
    webhookDispatchEvents,
    emailEvents,
    imageProcessingEvents,
    analyticsEvents,
    exportsEvents,
    emailNotificationEvents,
  ];

  await Promise.allSettled(queues.map((q) => q.close()));
  await Promise.allSettled(events.map((e) => e.close()));
  await Promise.allSettled([
    redis.quit().catch(() => undefined),
    emailNotificationRedis.quit().catch(() => undefined),
    emailNotificationEventsRedis.quit().catch(() => undefined),
  ]);
}
