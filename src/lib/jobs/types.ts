/**
 * Shared job queue types.
 *
 * A small adapter interface (`JobQueue`) lets the rest of the application depend
 * on an abstraction rather than on BullMQ directly: production uses the Redis
 * backed adapter, while tests (and local development) use an in-memory one.
 */

export const QUEUE_NAMES = {
  EMAIL: 'email',
  IMAGE: 'image',
  ANALYTICS: 'analytics',
  STELLAR_CONFIRMATION: 'stellar-confirmation',
  WEBHOOK_DISPATCH: 'webhook-dispatch',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEAD_LETTER_SUFFIX = '-dlq';

export function deadLetterQueueName(queueName: string): string {
  return `${queueName}${DEAD_LETTER_SUFFIX}`;
}

export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * BullMQ treats lower numeric values as higher priority, so these map an
 * expressive priority label onto BullMQ's scale.
 */
export const JOB_PRIORITY_VALUES: Record<JobPriority, number> = {
  critical: 1,
  high: 5,
  normal: 10,
  low: 20,
};

export function resolvePriority(priority: JobPriority | number | undefined): number {
  if (priority === undefined) {
    return JOB_PRIORITY_VALUES.normal;
  }
  if (typeof priority === 'number') {
    return priority;
  }
  return JOB_PRIORITY_VALUES[priority] ?? JOB_PRIORITY_VALUES.normal;
}

export type JobState =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused'
  | 'prioritized'
  | 'waiting-children'
  | 'stalled'
  | 'unknown';

export interface JobBackoffOptions {
  type: 'fixed' | 'exponential';
  delay: number;
}

export interface RepeatOptions {
  /** Cron expression (e.g. `0 * * * *`). */
  pattern?: string;
  /** Fixed interval in milliseconds. */
  every?: number;
  /** Run the job immediately when the repeatable job is first registered. */
  immediately?: boolean;
  limit?: number;
}

export interface EnqueueOptions {
  priority?: JobPriority | number;
  attempts?: number;
  backoff?: JobBackoffOptions;
  delay?: number;
  /** Stable id used for idempotent enqueues. */
  jobId?: string;
  repeat?: RepeatOptions;
  /** Remove the job once it completes (keeps Redis tidy). */
  removeOnComplete?: boolean;
  /** Keep the last N completed jobs. */
  keepCompleted?: number;
}

export interface JobRecord<T = unknown> {
  id: string;
  name: string;
  queue: string;
  data: T;
  state: JobState;
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  priority: number;
  failedReason?: string;
  result?: unknown;
  createdAt?: string;
  processedAt?: string;
  finishedAt?: string;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  prioritized: number;
  waitingChildren: number;
}

export interface JobQueue {
  readonly name: string;
  enqueue<T>(jobName: string, data: T, options?: EnqueueOptions): Promise<JobRecord<T>>;
  getJob(id: string): Promise<JobRecord | null>;
  list(limit?: number): Promise<JobRecord[]>;
  remove(id: string): Promise<void>;
  getCounts(): Promise<QueueCounts>;
  close(): Promise<void>;
}

export const DEFAULT_JOB_ATTEMPTS = 3;
export const DEFAULT_BACKOFF: JobBackoffOptions = { type: 'exponential', delay: 1000 };

export const emptyQueueCounts = (): QueueCounts => ({
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
  prioritized: 0,
  waitingChildren: 0,
});
