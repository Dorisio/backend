import { Queue, QueueEvents, type JobsOptions, type ConnectionOptions } from 'bullmq';
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

export function backoffStrategy(attemptsMade: number): number {
  const idx = Math.min(Math.max(attemptsMade - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

export function priorityValue(name: JobPriorityName = 'normal'): number {
  return JobPriority[name];
}

const connection = bullConnection;

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

export async function closeQueues() {
  await Promise.all(allQueues.map((q) => q.close()));
  await Promise.all([
    stellarConfirmationEvents.close(),
    webhookDispatchEvents.close(),
    emailEvents.close(),
    imageProcessingEvents.close(),
    analyticsEvents.close(),
    exportsEvents.close(),
  ]);
}
