import { Queue, QueueEvents, type JobsOptions, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * BullMQ connection options. `maxRetriesPerRequest: null` lets commands
 * queue offline while Redis is unreachable instead of failing immediately
 * (required by BullMQ workers).
 */
export const bullConnection: ConnectionOptions = {
  url: config.REDIS_URL,
  maxRetriesPerRequest: null,
};

/** Priority: higher number = processed first. */
export const JobPriority = {
  low: 1,
  normal: 5,
  high: 10,
} as const;
export type JobPriorityName = keyof typeof JobPriority;

/** Retry delays: 5s, 30s, 5min, 30min, 24h (Issue #27). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000, 1_800_000, 86_400_000] as const;

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'custom',
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: false, // keep for DLQ inspection
  priority: JobPriority.normal,
};

/**
 * Custom backoff used by every worker (`settings.backoffStrategy`):
 * delays by `RETRY_DELAYS_MS[attemptsMade - 1]`, clamped to the last entry.
 */
export function backoffStrategy(attemptsMade: number): number {
  const idx = Math.min(Math.max(attemptsMade - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

export function priorityValue(name: JobPriorityName = 'normal'): number {
  return JobPriority[name];
}

export const QUEUE_NAMES = {
  stellarConfirmation: 'stellar-confirmation',
  webhookDispatch: 'webhook-dispatch',
  email: 'email',
  emailNotifications: 'email-notifications',
  imageProcessing: 'image-processing',
  analytics: 'analytics',
  exports: 'exports',
  deadLetter: 'dead-letter',
} as const;

/**
 * Creates a queue on the shared connection and routes connection errors
 * through the logger. Without the `error` listener BullMQ falls back to
 * `console.error` when Redis is unreachable.
 */
function createQueue(name: string, options?: JobsOptions): Queue {
  const queue = options
    ? new Queue(name, { connection: bullConnection, defaultJobOptions: options })
    : new Queue(name, { connection: bullConnection });
  queue.on('error', (error: Error) =>
    logger.warn({ queue: name, error: error.message }, 'queue connection error'),
  );
  return queue;
}

export const stellarConfirmationQueue = createQueue(QUEUE_NAMES.stellarConfirmation, defaultJobOptions);
export const webhookDispatchQueue = createQueue(QUEUE_NAMES.webhookDispatch, defaultJobOptions);
export const emailQueue = createQueue(QUEUE_NAMES.email, defaultJobOptions);
export const emailNotificationQueue = createQueue(QUEUE_NAMES.emailNotifications, defaultJobOptions);
export const imageProcessingQueue = createQueue(QUEUE_NAMES.imageProcessing, defaultJobOptions);
export const analyticsQueue = createQueue(QUEUE_NAMES.analytics, defaultJobOptions);
export const exportsQueue = createQueue(QUEUE_NAMES.exports, defaultJobOptions);
export const deadLetterQueue = createQueue(QUEUE_NAMES.deadLetter);

export const allQueues = [
  stellarConfirmationQueue,
  webhookDispatchQueue,
  emailQueue,
  imageProcessingQueue,
  analyticsQueue,
  exportsQueue,
  deadLetterQueue,
];

/**
 * Dedicated client for the email notification worker (it spawns its own
 * connection via `.duplicate()`), so worker reconnects never disturb the
 * shared queue connections.
 */
export const emailNotificationRedis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
emailNotificationRedis.on('error', (error: Error) =>
  logger.warn({ error: error.message }, 'email notification redis error'),
);

function attachEvents(name: string): QueueEvents {
  const events = new QueueEvents(name, { connection: bullConnection });
  events.on('error', (error: Error) =>
    logger.warn({ queue: name, error: error.message }, 'queue events connection error'),
  );
  events.on('completed', ({ jobId }) => logger.info({ queue: name, jobId }, 'job completed'));
  events.on('failed', ({ jobId, failedReason }) =>
    logger.error({ queue: name, jobId, failedReason }, 'job failed'),
  );
  events.on('progress', ({ jobId, data }) =>
    logger.debug({ queue: name, jobId, data }, 'job progress'),
  );
  return events;
}

export const stellarConfirmationEvents = attachEvents(QUEUE_NAMES.stellarConfirmation);
export const webhookDispatchEvents = attachEvents(QUEUE_NAMES.webhookDispatch);
export const emailEvents = attachEvents(QUEUE_NAMES.email);
export const emailNotificationEvents = attachEvents(QUEUE_NAMES.emailNotifications);
export const imageProcessingEvents = attachEvents(QUEUE_NAMES.imageProcessing);
export const analyticsEvents = attachEvents(QUEUE_NAMES.analytics);
export const exportsEvents = attachEvents(QUEUE_NAMES.exports);

export async function moveToDeadLetter(
  sourceQueue: string,
  jobId: string,
  payload: unknown,
  failedReason: string,
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
    { removeOnComplete: false, removeOnFail: false },
  );
  logger.warn({ sourceQueue, jobId, failedReason }, 'job moved to dead-letter queue');
}

export interface QueueHealthReport {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  depth: number;
}

export async function getQueueHealth(): Promise<QueueHealthReport[]> {
  const report: QueueHealthReport[] = [];
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

/** How long closeQueues may block before giving up on an unreachable Redis. */
const CLOSE_TIMEOUT_MS = 3_000;

/**
 * Closes every queue, event listener and the email notification client.
 *
 * BullMQ/ioredis buffer commands while Redis is down, which makes `close()`
 * block indefinitely — shutdown must not hang on a dead Redis, so the wait
 * is capped and every outcome (including rejection) is swallowed here.
 */
export async function closeQueues(): Promise<void> {
  const closables: Promise<unknown>[] = [
    ...allQueues.map((q) => q.close()),
    emailNotificationQueue.close(),
    stellarConfirmationEvents.close(),
    webhookDispatchEvents.close(),
    emailEvents.close(),
    emailNotificationEvents.close(),
    imageProcessingEvents.close(),
    analyticsEvents.close(),
    exportsEvents.close(),
    emailNotificationRedis.quit().catch(() => undefined),
  ];

  await Promise.race([
    Promise.allSettled(closables),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
}
