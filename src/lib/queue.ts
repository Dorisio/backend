import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from 'redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

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

// Job queues
export const stellarConfirmationQueue = new Queue('stellar-confirmation', {
  connection: redis as any,
});
export const webhookDispatchQueue = new Queue('webhook-dispatch', { connection: redis as any });
export const emailNotificationRedis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const emailNotificationEventsRedis = emailNotificationRedis.duplicate();
export const emailNotificationQueue = new Queue('email-notifications', { connection: emailNotificationRedis as any });

export function priorityValue(name: JobPriorityName = 'normal'): number {
  return JobPriority[name];
}

export const webhookDispatchEvents = new QueueEvents('webhook-dispatch', {
  connection: redis as any,
});
export const emailNotificationEvents = new QueueEvents('email-notifications', { connection: emailNotificationEventsRedis as any });

export const QUEUE_NAMES = {
  stellarConfirmation: 'stellar-confirmation',
  webhookDispatch: 'webhook-dispatch',
  email: 'email',
  imageProcessing: 'image-processing',
  analytics: 'analytics',
  exports: 'exports',
  deadLetter: 'dead-letter',
} as const;

export const stellarConfirmationQueue = new Queue(QUEUE_NAMES.stellarConfirmation, {
  connection,
  defaultJobOptions
});
export const webhookDispatchQueue = new Queue(QUEUE_NAMES.webhookDispatch, {
  connection,
  defaultJobOptions
});
export const emailQueue = new Queue(QUEUE_NAMES.email, {
  connection,
  defaultJobOptions
});
export const imageProcessingQueue = new Queue(QUEUE_NAMES.imageProcessing, {
  connection,
  defaultJobOptions
});
export const analyticsQueue = new Queue(QUEUE_NAMES.analytics, {
  connection,
  defaultJobOptions
});
export const exportsQueue = new Queue(QUEUE_NAMES.exports, {
  connection,
  defaultJobOptions
});
export const deadLetterQueue = new Queue(QUEUE_NAMES.deadLetter, { connection });

export const allQueues = [
  stellarConfirmationQueue,
  webhookDispatchQueue,
  emailQueue,
  imageProcessingQueue,
  analyticsQueue,
  exportsQueue,
  deadLetterQueue,
];

function attachEvents(name: string) {
  const events = new QueueEvents(name, { connection });
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

export async function closeQueues() {
  await stellarConfirmationQueue.close();
  await webhookDispatchQueue.close();
  await emailNotificationQueue.close();
  await stellarConfirmationEvents.close();
  await webhookDispatchEvents.close();
  await emailNotificationEvents.close();
  await emailNotificationRedis.quit();
  await emailNotificationEventsRedis.quit();
  await redis.quit();
}
