import {
  DEFAULT_JOB_ATTEMPTS,
  DEAD_LETTER_SUFFIX,
  JobQueue,
  JobRecord,
  deadLetterQueueName,
} from './types';

/**
 * A dead letter record captures a job that exhausted its retries so it can be
 * inspected and, when the underlying problem is fixed, replayed.
 */
export interface DeadLetterRecord {
  originalJobId: string;
  originalName: string;
  originalQueue: string;
  payload: unknown;
  failedReason: string;
  attemptsMade: number;
  maxAttempts: number;
  priority: number;
  deadLetteredAt: string;
}

export function isExhausted(attemptsMade: number, maxAttempts: number): boolean {
  const limit = maxAttempts > 0 ? maxAttempts : DEFAULT_JOB_ATTEMPTS;
  return attemptsMade >= limit;
}

export function buildDeadLetterRecord(job: JobRecord, error?: unknown): DeadLetterRecord {
  const failureMessage =
    (error instanceof Error && error.message) ||
    job.failedReason ||
    (typeof error === 'string' ? error : 'Unknown failure');

  return {
    originalJobId: job.id,
    originalName: job.name,
    originalQueue: job.queue,
    payload: job.data,
    failedReason: failureMessage,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts || DEFAULT_JOB_ATTEMPTS,
    priority: job.priority,
    deadLetteredAt: new Date().toISOString(),
  };
}

export function isDeadLetterQueueName(queueName: string): boolean {
  return queueName.endsWith(DEAD_LETTER_SUFFIX);
}

/**
 * Moves permanently failed jobs onto a dedicated dead letter queue and can
 * replay them later.
 */
export class DeadLetterManager {
  constructor(private readonly deadLetterQueue: JobQueue) {}

  get queueName(): string {
    return this.deadLetterQueue.name;
  }

  /** Stores a failed job for later inspection/replay. */
  async add(job: JobRecord, error?: unknown): Promise<JobRecord<DeadLetterRecord>> {
    const record = buildDeadLetterRecord(job, error);
    return this.deadLetterQueue.enqueue<DeadLetterRecord>('dead-letter', record, {
      jobId: `${record.originalQueue}:${record.originalJobId}`,
      removeOnComplete: false,
    });
  }

  /** Lists the jobs currently parked on the dead letter queue. */
  async list(limit?: number): Promise<JobRecord<DeadLetterRecord>[]> {
    const jobs = await this.deadLetterQueue.list(limit);
    return jobs as JobRecord<DeadLetterRecord>[];
  }

  /**
   * Re-enqueues a dead lettered job onto its original queue. Returns the new job
   * or `null` when the record is missing.
   */
  async replay(id: string, target: JobQueue): Promise<JobRecord | null> {
    const deadLetter = (await this.deadLetterQueue.getJob(id)) as JobRecord<DeadLetterRecord> | null;
    if (!deadLetter) {
      return null;
    }

    const record = deadLetter.data;
    await this.deadLetterQueue.remove(id);

    return target.enqueue(record.originalName, record.payload, {
      priority: record.priority,
    });
  }

  /** Removes every dead lettered job. Returns the number removed. */
  async purge(): Promise<number> {
    const jobs = await this.deadLetterQueue.list();
    for (const job of jobs) {
      await this.deadLetterQueue.remove(job.id);
    }
    return jobs.length;
  }
}

export function createDeadLetterQueueName(queueName: string): string {
  return deadLetterQueueName(queueName);
}
