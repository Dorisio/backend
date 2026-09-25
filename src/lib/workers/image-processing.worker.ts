import { Worker, Job } from 'bullmq';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export function createImageProcessingWorker() {
  const worker = new Worker(
    QUEUE_NAMES.imageProcessing,
    async (job: Job) => {
      await job.updateProgress(25);
      logger.info({ assetUrl: job.data.assetUrl, ops: job.data.operations }, 'processing image');
      await job.updateProgress(100);
      return { processed: true, assetUrl: job.data.assetUrl };
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    },
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.imageProcessing, String(job.id), job.data, err.message);
    }
  });

  return worker;
}
