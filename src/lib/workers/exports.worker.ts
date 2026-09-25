import { Worker, Job } from 'bullmq';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export function createExportsWorker() {
  const worker = new Worker(
    QUEUE_NAMES.exports,
    async (job: Job) => {
      await job.updateProgress(15);
      logger.info({ userId: job.data.userId, type: job.data.type }, 'generating export');
      await job.updateProgress(100);
      return { ok: true, downloadPath: `/exports/${job.id}.${job.data.format ?? 'csv'}` };
    },
    {
      connection: bullConnection,
      concurrency: Math.max(1, Math.floor(config.WORKER_CONCURRENCY / 2)),
      settings: { backoffStrategy },
    },
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.exports, String(job.id), job.data, err.message);
    }
  });

  return worker;
}
