import {
  DEFAULT_JOB_ATTEMPTS,
  EnqueueOptions,
  JobQueue,
  JobRecord,
  QueueCounts,
  emptyQueueCounts,
  resolvePriority,
} from './types';

export type JobProcessor<T = unknown> = (job: JobRecord<T>) => Promise<unknown> | unknown;

/**
 * In-memory `JobQueue` implementation.
 *
 * Used by tests (so they never need a live Redis) and useful for local
 * development. It implements the same contract as the BullMQ adapter, including
 * priority ordering, idempotent enqueues and retry accounting.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private sequence = 0;
  private processors = new Map<string, JobProcessor>();
  private now: () => number;

  constructor(readonly name: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  setProcessor<T>(jobName: string, processor: JobProcessor<T>): void {
    this.processors.set(jobName, processor as JobProcessor);
  }

  async enqueue<T>(jobName: string, data: T, options: EnqueueOptions = {}): Promise<JobRecord<T>> {
    const id = options.jobId ?? `${this.name}:${++this.sequence}`;

    // Idempotent enqueue: an existing job with the same id is returned as-is.
    const existing = this.jobs.get(id);
    if (existing) {
      return existing as JobRecord<T>;
    }

    const record: JobRecord<T> = {
      id,
      name: jobName,
      queue: this.name,
      data,
      // Repeatable jobs are registered as waiting; the scheduler re-enqueues them.
      state: options.delay ? 'delayed' : 'waiting',
      progress: 0,
      attemptsMade: 0,
      maxAttempts: options.attempts ?? DEFAULT_JOB_ATTEMPTS,
      priority: resolvePriority(options.priority),
      createdAt: new Date(this.now()).toISOString(),
    };

    this.jobs.set(id, record as JobRecord);
    return record;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async list(limit?: number): Promise<JobRecord[]> {
    const all = [...this.jobs.values()];
    return limit === undefined ? all : all.slice(0, limit);
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async getCounts(): Promise<QueueCounts> {
    const counts = emptyQueueCounts();
    for (const job of this.jobs.values()) {
      switch (job.state) {
        case 'waiting':
          counts.waiting += 1;
          break;
        case 'active':
          counts.active += 1;
          break;
        case 'completed':
          counts.completed += 1;
          break;
        case 'failed':
          counts.failed += 1;
          break;
        case 'delayed':
          counts.delayed += 1;
          break;
        case 'paused':
          counts.paused += 1;
          break;
        case 'prioritized':
          counts.prioritized += 1;
          break;
        case 'waiting-children':
          counts.waitingChildren += 1;
          break;
        default:
          break;
      }
    }
    return counts;
  }

  async close(): Promise<void> {
    this.processors.clear();
  }

  /** Number of jobs currently stored (including completed/failed). */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * Picks the highest priority waiting job (lowest numeric value, then FIFO) and
   * runs its processor. Returns false when there is nothing to process.
   */
  async processNext(): Promise<boolean> {
    const candidates = [...this.jobs.values()]
      .filter((job) => job.state === 'waiting')
      .sort((a, b) => a.priority - b.priority || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

    const job = candidates[0];
    if (!job) {
      return false;
    }

    const processor = this.processors.get(job.name);
    job.state = 'active';
    job.processedAt = new Date(this.now()).toISOString();

    try {
      if (!processor) {
        throw new Error(`No processor registered for job "${job.name}"`);
      }
      const result = await processor(job);
      job.state = 'completed';
      job.progress = 100;
      job.result = result;
      job.finishedAt = new Date(this.now()).toISOString();
      return true;
    } catch (error) {
      job.attemptsMade += 1;
      job.failedReason = error instanceof Error ? error.message : String(error);

      if (job.attemptsMade >= job.maxAttempts) {
        job.state = 'failed';
        job.finishedAt = new Date(this.now()).toISOString();
      } else {
        job.state = 'waiting';
      }
      return true;
    }
  }

  /** Drains all runnable jobs (used by tests). */
  async drain(maxIterations = 100): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxIterations; i++) {
      const didWork = await this.processNext();
      if (!didWork) break;
      processed += 1;
    }
    return processed;
  }
}

/** Convenience helper for tests. */
export function createInMemoryQueue(name: string): InMemoryJobQueue {
  return new InMemoryJobQueue(name);
}
