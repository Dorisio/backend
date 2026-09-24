import { EnqueueOptions, JobPriority, JobQueue, JobRecord, RepeatOptions, resolvePriority } from './types';

/**
 * Cron-like scheduling. Repeatable jobs are registered once and BullMQ keeps
 * them firing on the given cadence, so a single scheduler call survives restarts.
 */

export interface JobSchedule {
  /** Standard 5-field cron expression. */
  cron?: string;
  /** Fixed interval in milliseconds. */
  every?: number;
  /** Fire once immediately in addition to the recurring schedule. */
  immediately?: boolean;
  /** Cap the number of executions (mostly useful for tests/one-offs). */
  limit?: number;
  priority?: JobPriority | number;
}

export const CRON_PRESETS = {
  everyMinute: '* * * * *',
  everyFiveMinutes: '*/5 * * * *',
  hourly: '0 * * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
  /** Nightly analytics rollup. */
  analyticsRollup: '0 2 * * *',
} as const;

export function toRepeatOptions(schedule: JobSchedule): RepeatOptions {
  if (!schedule.cron && !schedule.every) {
    throw new Error('A schedule requires either a cron pattern or an interval');
  }

  const repeat: RepeatOptions = {};
  if (schedule.cron) repeat.pattern = schedule.cron;
  if (schedule.every) repeat.every = schedule.every;
  if (schedule.immediately !== undefined) repeat.immediately = schedule.immediately;
  if (schedule.limit !== undefined) repeat.limit = schedule.limit;
  return repeat;
}

export function toEnqueueOptions(schedule: JobSchedule): EnqueueOptions {
  return {
    repeat: toRepeatOptions(schedule),
    priority: resolvePriority(schedule.priority),
  };
}

/**
 * Registers (or updates) a repeatable job on the given queue.
 */
export async function scheduleJob<T>(
  queue: JobQueue,
  jobName: string,
  data: T,
  schedule: JobSchedule
): Promise<JobRecord<T>> {
  return queue.enqueue(jobName, data, toEnqueueOptions(schedule));
}

/**
 * A deterministic, collision-free id for a repeatable job so re-registering the
 * same schedule is idempotent.
 */
export function scheduledJobId(queueName: string, jobName: string, schedule: JobSchedule): string {
  const cadence = schedule.cron ? `cron:${schedule.cron}` : `every:${schedule.every}`;
  return `repeat:${queueName}:${jobName}:${cadence}`;
}
