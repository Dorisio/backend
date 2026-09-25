import { DeadLetterManager, DeadLetterRecord } from './dead-letter';
import { JobEventBus, createJobEvent, jobEvents as defaultEvents } from './events';
import { recordJobEnqueued, setDeadLetterCount, updateQueueDepth } from './metrics';
import { JobSchedule, scheduleJob } from './scheduler';
import { EnqueueOptions, JobQueue, JobRecord, QueueCounts } from './types';

/**
 * Facade over the configured queues.
 *
 * Everything the rest of the app needs — enqueue with priority, schedule,
 * inspect status, cancel, monitor depth and replay dead letters — goes through
 * here so route/service code never touches BullMQ directly.
 */
export interface JobServiceOptions {
  /** Queues known up front. Unknown queues are created via `createQueue`. */
  queues?: Map<string, JobQueue>;
  /** Factory used to lazily create a queue the first time it is used. */
  createQueue?: (name: string) => JobQueue;
  /** Optional dead letter queue backing replay/purge operations. */
  deadLetterQueue?: JobQueue;
  events?: JobEventBus;
}

export class JobService {
  private readonly queues: Map<string, JobQueue>;
  private readonly createQueue?: (name: string) => JobQueue;
  private readonly events: JobEventBus;
  private readonly deadLetters?: DeadLetterManager;

  constructor(options: JobServiceOptions = {}) {
    this.queues = options.queues ?? new Map();
    this.createQueue = options.createQueue;
    this.events = options.events ?? defaultEvents;
    this.deadLetters = options.deadLetterQueue
      ? new DeadLetterManager(options.deadLetterQueue)
      : undefined;
  }

  getQueue(name: string): JobQueue {
    const existing = this.queues.get(name);
    if (existing) {
      return existing;
    }
    if (!this.createQueue) {
      throw new Error(`Queue "${name}" is not registered`);
    }
    const created = this.createQueue(name);
    this.queues.set(name, created);
    return created;
  }

  async enqueue<T>(
    queueName: string,
    jobName: string,
    data: T,
    options: EnqueueOptions = {}
  ): Promise<JobRecord<T>> {
    const queue = this.getQueue(queueName);
    const job = await queue.enqueue(jobName, data, options);

    recordJobEnqueued(queueName, jobName, job.priority || 'normal');
    this.events.emit(
      createJobEvent('enqueued', {
        queue: queueName,
        jobId: job.id,
        name: jobName,
        data,
        attemptsMade: job.attemptsMade,
        state: job.state,
      })
    );

    return job;
  }

  async schedule<T>(
    queueName: string,
    jobName: string,
    data: T,
    schedule: JobSchedule
  ): Promise<JobRecord<T>> {
    const queue = this.getQueue(queueName);
    const job = await scheduleJob(queue, jobName, data, schedule);
    recordJobEnqueued(queueName, jobName, job.priority || 'normal');
    return job;
  }

  async getStatus(queueName: string, jobId: string): Promise<JobRecord | null> {
    const job = await this.getQueue(queueName).getJob(jobId);
    if (!job) {
      return null;
    }
    return job;
  }

  /**
   * Removes a job that has not started yet. Active jobs cannot be cancelled
   * (the processor must cooperate) and completed jobs are immutable.
   */
  async cancel(queueName: string, jobId: string): Promise<boolean> {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      return false;
    }

    const cancellable = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'];
    if (!cancellable.includes(job.state)) {
      return false;
    }

    await queue.remove(jobId);
    return true;
  }

  async getQueueDepth(queueName: string): Promise<QueueCounts> {
    const counts = await this.getQueue(queueName).getCounts();
    updateQueueDepth(queueName, counts);
    return counts;
  }

  async getDeadLetterJobs(limit?: number): Promise<JobRecord<DeadLetterRecord>[]> {
    if (!this.deadLetters) {
      return [];
    }
    const jobs = await this.deadLetters.list(limit);
    setDeadLetterCount(this.deadLetters.queueName, jobs.length);
    return jobs;
  }

  async retryDeadLetter(id: string, queueName: string): Promise<JobRecord | null> {
    if (!this.deadLetters) {
      return null;
    }
    return this.deadLetters.replay(id, this.getQueue(queueName));
  }

  async purgeDeadLetters(): Promise<number> {
    if (!this.deadLetters) {
      return 0;
    }
    return this.deadLetters.purge();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

export function createJobService(options: JobServiceOptions = {}): JobService {
  return new JobService(options);
}
