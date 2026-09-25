import { Job, Queue, QueueOptions } from 'bullmq';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  EnqueueOptions,
  JobQueue,
  JobRecord,
  JobState,
  QueueCounts,
  emptyQueueCounts,
  resolvePriority,
} from './types';

/**
 * BullMQ backed job queue.
 *
 * Connections are created lazily by BullMQ itself (ioredis under the hood), so
 * merely importing this module never opens a socket — important for tests and
 * for processes that do not run workers.
 */

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, unknown>;
}

export function redisConnectionOptions(url: string = config.REDIS_URL): RedisConnectionOptions {
  const parsed = new URL(url);
  const options: RedisConnectionOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : 6379,
  };

  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  if (parsed.pathname && parsed.pathname.length > 1) {
    const db = Number(parsed.pathname.slice(1));
    if (!Number.isNaN(db)) options.db = db;
  }
  if (parsed.protocol === 'rediss:') options.tls = {};

  return options;
}

/** BullMQ job types we query and map onto our own state union. */
export const BULL_JOB_TYPES = [
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
] as const;

function toState(state: string): JobState {
  return (BULL_JOB_TYPES as readonly string[]).includes(state) ? (state as JobState) : 'unknown';
}

export function toJobRecord(job: Job): JobRecord {
  return {
    id: String(job.id),
    name: job.name,
    queue: job.queueName,
    data: job.data,
    state: toState(job.isFailed() ? 'failed' : (job.finishedOn ? 'completed' : 'waiting')),
    progress: typeof job.progress === 'number' ? job.progress : 0,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    priority: job.opts.priority ?? resolvePriority(undefined),
    failedReason: job.failedReason,
    result: job.returnvalue,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : undefined,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
  };
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(readonly name: string, options: Omit<QueueOptions, 'connection'> = {}) {
    this.queue = new Queue(name, {
      connection: redisConnectionOptions(),
      ...options,
    });
  }

  async enqueue<T>(jobName: string, data: T, options: EnqueueOptions = {}): Promise<JobRecord<T>> {
    const removeOnComplete = options.keepCompleted
      ? { count: options.keepCompleted }
      : (options.removeOnComplete ?? false);

    const job = await this.queue.add(jobName, data, {
      priority: resolvePriority(options.priority),
      attempts: options.attempts,
      backoff: options.backoff,
      delay: options.delay,
      jobId: options.jobId,
      repeat: options.repeat,
      removeOnComplete,
    });

    logger.debug({ queue: this.name, jobName, jobId: job.id }, 'Job enqueued');
    return toJobRecord(job) as JobRecord<T>;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = await this.queue.getJob(id);
    return job ? toJobRecord(job) : null;
  }

  async list(limit = 100): Promise<JobRecord[]> {
    const jobs = await this.queue.getJobs([...BULL_JOB_TYPES], 0, Math.max(0, limit - 1));
    return jobs.map(toJobRecord);
  }

  async remove(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (job) {
      await job.remove();
    }
  }

  async getCounts(): Promise<QueueCounts> {
    const counts = emptyQueueCounts();
    const raw = (await this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
      'prioritized',
      'waiting-children'
    )) as Record<string, number>;

    counts.waiting = raw.waiting ?? 0;
    counts.active = raw.active ?? 0;
    counts.completed = raw.completed ?? 0;
    counts.failed = raw.failed ?? 0;
    counts.delayed = raw.delayed ?? 0;
    counts.paused = raw.paused ?? 0;
    counts.prioritized = raw.prioritized ?? 0;
    counts.waitingChildren = raw['waiting-children'] ?? 0;
    return counts;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export function createBullQueue(name: string): BullJobQueue {
  return new BullJobQueue(name);
}
