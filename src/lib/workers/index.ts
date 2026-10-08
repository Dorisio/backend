import type { PrismaClient } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { CRON_PRESETS, scheduleJob } from '../jobs/scheduler';
import { createBullQueue } from '../jobs/bull-queue';
import { QUEUE_NAMES } from '../jobs/types';
import { createAnalyticsWorker } from './analytics.worker';
import { createEmailWorker } from './email.worker';
import { createExportsWorker } from './exports.worker';
import { createImageProcessingWorker } from './image-processing.worker';
import { createStellarConfirmationWorker } from './stellar-confirmation.worker';
import { createWebhookDispatchWorker } from './webhook-dispatch.worker';

/**
 * Registers the recurring jobs workers rely on. Idempotent: repeatable jobs
 * are keyed by queue + name + cadence, so re-registering on every boot simply
 * updates the existing schedule.
 */
async function registerScheduledJobs(): Promise<void> {
  const analyticsQueue = createBullQueue(QUEUE_NAMES.ANALYTICS);
  await scheduleJob(analyticsQueue, 'analytics.aggregate', {}, {
    cron: CRON_PRESETS.analyticsRollup,
  });
}

/**
 * Start the worker pool. `prisma` is forwarded to the workers that need database
 * access (media processing); workers that only touch Redis or Stellar ignore it.
 */
export async function startWorkers(prisma?: PrismaClient) {
  const workers = [
    createStellarConfirmationWorker(),
    createWebhookDispatchWorker(),
    createEmailWorker(),
    createImageProcessingWorker(prisma),
    createAnalyticsWorker(),
    createExportsWorker(),
  ];

  await registerScheduledJobs();
  logger.info(
    { concurrency: config.WORKER_CONCURRENCY, count: workers.length },
    'Background workers started',
  );

  return workers;
}

// Allow `pnpm worker` to run the pool as a standalone process.
const isDirectRun = process.argv[1]?.includes('workers/index');
if (isDirectRun) {
  startWorkers().catch((err) => {
    logger.error(err, 'Failed to start workers');
    process.exit(1);
  });
}
