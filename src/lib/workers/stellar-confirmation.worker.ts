import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

export function createStellarConfirmationWorker() {
  const worker = new Worker(
    QUEUE_NAMES.stellarConfirmation,
    async (job: Job) => {
      const { tipId, transactionHash } = job.data;
      logger.info(`Processing Stellar confirmation for tip ${tipId} (hash: ${transactionHash})`);
      await job.updateProgress(30);

      await prisma.tip.update({
        where: { id: tipId },
        data: { status: 'confirmed', updatedAt: new Date() },
      });

      await job.updateProgress(100);
      return { confirmed: true, tipId, transactionHash };
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    },
  );

  worker.on('completed', (job) => {
    logger.info(`Stellar confirmation worker completed job ${job.id}`);
  });

  worker.on('failed', async (job, err) => {
    logger.error(`Stellar confirmation worker failed job ${job?.id}:`, err);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.stellarConfirmation, String(job.id), job.data, err.message);
    }
  });

  return worker;
}

/** @deprecated prefer createStellarConfirmationWorker() */
export const stellarConfirmationWorker = createStellarConfirmationWorker();
