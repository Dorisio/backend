import { describe, it, expect } from 'vitest';
import { CRON_PRESETS, scheduleJob, scheduledJobId, toEnqueueOptions, toRepeatOptions } from '../scheduler';
import { InMemoryJobQueue } from '../memory-queue';

describe('toRepeatOptions', () => {
  it('supports cron patterns', () => {
    expect(toRepeatOptions({ cron: CRON_PRESETS.hourly })).toEqual({ pattern: '0 * * * *' });
  });

  it('supports fixed intervals', () => {
    expect(toRepeatOptions({ every: 60_000 })).toEqual({ every: 60_000 });
  });

  it('passes through immediately and limit', () => {
    expect(toRepeatOptions({ every: 1000, immediately: true, limit: 3 })).toEqual({
      every: 1000,
      immediately: true,
      limit: 3,
    });
  });

  it('throws when no cadence is provided', () => {
    expect(() => toRepeatOptions({})).toThrow();
  });
});

describe('toEnqueueOptions', () => {
  it('resolves priority and repeat options', () => {
    const options = toEnqueueOptions({ cron: CRON_PRESETS.daily, priority: 'high' });
    expect(options.priority).toBe(5);
    expect(options.repeat).toEqual({ pattern: '0 0 * * *' });
  });
});

describe('scheduledJobId', () => {
  it('is deterministic for the same schedule', () => {
    const first = scheduledJobId('analytics', 'analytics.aggregate', { cron: CRON_PRESETS.analyticsRollup });
    const second = scheduledJobId('analytics', 'analytics.aggregate', { cron: CRON_PRESETS.analyticsRollup });
    expect(first).toBe(second);
  });

  it('differs for different cadences', () => {
    const daily = scheduledJobId('analytics', 'j', { cron: CRON_PRESETS.daily });
    const hourly = scheduledJobId('analytics', 'j', { cron: CRON_PRESETS.hourly });
    expect(daily).not.toBe(hourly);
  });
});

describe('scheduleJob', () => {
  it('registers a repeatable job on the queue', async () => {
    const queue = new InMemoryJobQueue('analytics');
    const job = await scheduleJob(
      queue,
      'analytics.aggregate',
      { windowStart: 'a', windowEnd: 'b' },
      { cron: CRON_PRESETS.analyticsRollup, priority: 'low' }
    );

    expect(job.name).toBe('analytics.aggregate');
    expect(job.priority).toBe(20);
    expect(await queue.getJob(job.id)).not.toBeNull();
  });
});
