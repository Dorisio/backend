import { analyticsQueue, exportsQueue } from '../queue';
import { logger } from '../../utils/logger';

/**
 * Register repeatable/cron jobs (Issue #27).
 * Safe to call on every worker boot — BullMQ dedupes by key.
 */
export async function registerScheduledJobs(): Promise<void> {
  await analyticsQueue.add(
    'daily-platform-rollup',
    { creatorId: '*', rangeDays: 1 },
    {
      repeat: { pattern: '0 2 * * *' }, // 02:00 UTC daily
      jobId: 'cron-daily-analytics',
      priority: 1,
    },
  );

  await exportsQueue.add(
    'weekly-ops-export',
    { userId: 'system', type: 'analytics', format: 'csv' },
    {
      repeat: { pattern: '0 3 * * 1' }, // Mondays 03:00 UTC
      jobId: 'cron-weekly-export',
      priority: 1,
    },
  );

  logger.info('Registered scheduled (cron) jobs');
}
