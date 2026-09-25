import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { registerScheduledJobs } from '../jobs/scheduler';
import { createAnalyticsWorker } from './analytics.worker';
import { createEmailWorker } from './email.worker';
import { createExportsWorker } from './exports.worker';
import { createImageProcessingWorker } from './image-processing.worker';
import { createStellarConfirmationWorker } from './stellar-confirmation.worker';
import { createWebhookDispatchWorker } from './webhook-dispatch.worker';

export async function startWorkers() {
  const workers = [
    createStellarConfirmationWorker(),
    createWebhookDispatchWorker(),
    createEmailWorker(),
    createImageProcessingWorker(),
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
