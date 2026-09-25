import { Worker, Job } from 'bullmq';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export function createAnalyticsWorker() {
  const worker = new Worker(
    QUEUE_NAMES.analytics,
    async (job: Job) => {
      await job.updateProgress(20);
      logger.info({ creatorId: job.data.creatorId }, 'computing analytics rollup');
      // Heavy aggregation belongs here — not on the request path.
      await job.updateProgress(100);
      return { ok: true, creatorId: job.data.creatorId, rangeDays: job.data.rangeDays ?? 30 };
    },
    {
      connection: bullConnection,
      concurrency: Math.max(1, Math.floor(config.WORKER_CONCURRENCY / 2)),
      settings: { backoffStrategy },
    },
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.analytics, String(job.id), job.data, err.message);
    }
  });

  return worker;
}
