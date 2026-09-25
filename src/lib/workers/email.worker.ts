import { Worker, Job } from 'bullmq';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export function createEmailWorker() {
  const worker = new Worker(
    QUEUE_NAMES.email,
    async (job: Job) => {
      await job.updateProgress(10);
      logger.info({ to: job.data.to, subject: job.data.subject }, 'sending email (async)');
      // Provider integration point — SES/SendGrid/etc.
      await job.updateProgress(100);
      return { sent: true, to: job.data.to };
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    },
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.email, String(job.id), job.data, err.message);
    }
  });

  return worker;
}
