import { Job, Worker, WorkerOptions } from 'bullmq';
import { logger } from '../../utils/logger';
import { redisConnectionOptions, toJobRecord } from './bull-queue';
import { DeadLetterManager, isExhausted } from './dead-letter';
import { createJobEvent, jobEvents, JobEventBus } from './events';
import { recordJobDuration, recordJobProcessed, recordJobRetry } from './metrics';
import { JobProcessor } from './processors';
import { JobQueue } from './types';

export interface WorkerFactoryOptions {
  concurrency?: number;
  /** Dead letter queue used for jobs that exhausted their retries. */
  deadLetterQueue?: JobQueue;
  events?: JobEventBus;
  /** Extra worker tuning; `connection` is always derived from REDIS_URL. */
  workerOptions?: Omit<Partial<WorkerOptions>, 'connection'>;
}

/**
 * Creates a BullMQ worker wired with metrics, job events and dead-letter
 * handling. A processor is required for every job name the queue can receive —
 * an unknown job fails fast instead of being silently dropped.
 */
export function createWorker(
  queueName: string,
  processors: Record<string, JobProcessor>,
  options: WorkerFactoryOptions = {}
): Worker {
  const events = options.events ?? jobEvents;
  const deadLetters = options.deadLetterQueue
    ? new DeadLetterManager(options.deadLetterQueue)
    : undefined;

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const processor = processors[job.name];
      if (!processor) {
        throw new Error(`No processor registered for job "${job.name}" on queue "${queueName}"`);
      }
      return processor(job.data, toJobRecord(job));
    },
    {
      connection: redisConnectionOptions(),
      concurrency: options.concurrency ?? 5,
      ...options.workerOptions,
    }
  );

  worker.on('completed', (job: Job) => {
    const durationMs = job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : 0;
    recordJobProcessed(queueName, job.name, 'completed');
    if (durationMs > 0) {
      recordJobDuration(queueName, job.name, durationMs);
    }
    events.emit(
      createJobEvent('completed', {
        queue: queueName,
        jobId: String(job.id),
        name: job.name,
        result: job.returnvalue,
        state: 'completed',
      })
    );
  });

  worker.on('failed', (job: Job | undefined, error: Error) => {
    if (!job) {
      return;
    }

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 1;

    if (isExhausted(attemptsMade, maxAttempts)) {
      recordJobProcessed(queueName, job.name, 'failed');
      events.emit(
        createJobEvent('failed', {
          queue: queueName,
          jobId: String(job.id),
          name: job.name,
          error: error?.message,
          attemptsMade,
          state: 'failed',
        })
      );

      if (deadLetters) {
        void deadLetters
          .add(toJobRecord(job), error)
          .then((record) => {
            logger.error(
              { queue: queueName, jobId: job.id, dlqJobId: record.id },
              'Job exhausted retries and was dead-lettered'
            );
            events.emit(
              createJobEvent('dead-letter', {
                queue: queueName,
                jobId: String(job.id),
                name: job.name,
                error: error?.message,
                attemptsMade,
                state: 'failed',
              })
            );
          })
          .catch((err) => logger.error({ err }, 'Failed to dead-letter job'));
      }
      return;
    }

    recordJobRetry(queueName, job.name);
    events.emit(
      createJobEvent('failed', {
        queue: queueName,
        jobId: String(job.id),
        name: job.name,
        error: error?.message,
        attemptsMade,
        state: 'waiting',
      })
    );
  });

  worker.on('progress', (job: Job, progress: number) => {
    events.emit(
      createJobEvent('progress', {
        queue: queueName,
        jobId: String(job.id),
        name: job.name,
        progress: typeof progress === 'number' ? progress : 0,
        state: 'active',
      })
    );
  });

  worker.on('error', (error) => {
    logger.error({ err: error, queue: queueName }, 'Job worker error');
  });

  return worker;
}

export function startWorkers(
  configs: Array<{ queue: string; processors: Record<string, JobProcessor> }>,
  options: WorkerFactoryOptions = {}
): Worker[] {
  return configs.map((config) => createWorker(config.queue, config.processors, options));
}
