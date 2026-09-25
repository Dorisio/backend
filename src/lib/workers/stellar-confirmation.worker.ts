import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { checkTransactionStatus } from '../stellar/transactions';
import { PaymentService } from '../../domains/payments/payment.service';
import { TipStatus } from '../../domains/payments/payment.types';

const prisma = new PrismaClient();
const paymentService = new PaymentService(prisma);

export function createStellarConfirmationWorker() {
  const worker = new Worker(
    QUEUE_NAMES.stellarConfirmation,
    async (job: Job) => {
      // payment.service passes { transactionId, transactionHash }
      const tipId = job.data.tipId || job.data.transactionId;
      const transactionHash = job.data.transactionHash;
      
      logger.info(`Processing Stellar confirmation for tip ${tipId} (hash: ${transactionHash})`);
      await job.updateProgress(10);

      const status = await checkTransactionStatus(transactionHash);

      if (status.circuitOpen) {
        logger.warn(`Circuit breaker open, delaying confirmation check for tip ${tipId}`);
        throw new Error('Circuit breaker open'); // Let BullMQ retry
      }

      if (status.confirmed) {
        await job.updateProgress(50);
        
        await paymentService.updateTipStatus(tipId, { status: TipStatus.COMPLETED });

        await job.updateProgress(100);
        return { confirmed: true, tipId, transactionHash };
      } else {
        logger.debug(`Transaction not confirmed yet for tip ${tipId}, will retry`);
        throw new Error('Transaction not confirmed yet');
      }
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`Stellar confirmation worker completed job ${job.id}`);
  });

  worker.on('failed', async (job, err) => {
    logger.error(`Stellar confirmation worker failed job ${job?.id}:`, err);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      const tipId = job.data.tipId || job.data.transactionId;
      try {
        await paymentService.updateTipStatus(tipId, { status: TipStatus.FAILED });
      } catch (e) {
        logger.error(`Failed to mark tip ${tipId} as FAILED:`, e);
      }
      await moveToDeadLetter(QUEUE_NAMES.stellarConfirmation, String(job.id), job.data, err.message);
    }
  });

  return worker;
}

/** @deprecated prefer createStellarConfirmationWorker() */
export const stellarConfirmationWorker = createStellarConfirmationWorker();
