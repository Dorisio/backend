import { config } from '../../config';
import { BullJobQueue } from './bull-queue';
import { InMemoryJobQueue } from './memory-queue';
import { createProcessors, ProcessorDependencies } from './processors';
import { JobService, createJobService } from './service';
import { startWorkers, WorkerFactoryOptions } from './worker';
import { deadLetterQueueName, QUEUE_NAMES } from './types';

export * from './types';
export * from './dead-letter';
export * from './events';
export * from './metrics';
export * from './retry';
export * from './scheduler';
export * from './service';
export * from './worker';
export * from './processors';
export { BullJobQueue, createBullQueue, redisConnectionOptions, toJobRecord } from './bull-queue';
export { InMemoryJobQueue, createInMemoryQueue } from './memory-queue';

/**
 * Creates the production job service: BullMQ queues plus a shared dead letter
 * queue. Queues are created lazily and never connect until first used.
 */
export function createConfiguredJobService(options: { deadLetterQueueName?: string } = {}): JobService {
  const queues = new Map<string, BullJobQueue>();
  const createQueue = (name: string): BullJobQueue => {
    const queue = new BullJobQueue(name);
    queues.set(name, queue);
    return queue;
  };

  return createJobService({
    createQueue,
    deadLetterQueue: new BullJobQueue(
      options.deadLetterQueueName ?? deadLetterQueueName(QUEUE_NAMES.EMAIL)
    ),
  });
}

/** Creates an in-memory job service (tests/local development). */
export function createInMemoryJobService(): JobService {
  const queues = new Map<string, InMemoryJobQueue>();
  const deadLetterQueue = new InMemoryJobQueue('jobs-dlq');
  return createJobService({
    createQueue: (name) => {
      const queue = new InMemoryJobQueue(name);
      queues.set(name, queue);
      return queue;
    },
    deadLetterQueue,
  });
}

export interface StartWorkersOptions {
  deps?: ProcessorDependencies;
  concurrency?: number;
  workerOptions?: WorkerFactoryOptions;
}

/**
 * Boots workers for all first-class queues. Only invoked when background
 * processing is explicitly enabled, so the API process stays lightweight.
 */
export function startConfiguredWorkers(options: StartWorkersOptions = {}) {
  const processors = createProcessors(options.deps);
  const deadLetterQueue = new BullJobQueue(deadLetterQueueName(QUEUE_NAMES.EMAIL));

  return startWorkers(
    [
      { queue: QUEUE_NAMES.EMAIL, processors },
      { queue: QUEUE_NAMES.IMAGE, processors },
      { queue: QUEUE_NAMES.ANALYTICS, processors },
      { queue: QUEUE_NAMES.STELLAR_CONFIRMATION, processors },
    ],
    {
      concurrency: options.concurrency ?? config.JOBS_CONCURRENCY,
      deadLetterQueue,
      workerOptions: options.workerOptions,
    }
  );
}
