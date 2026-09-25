import { describe, it, expect } from 'vitest';
import { backoffStrategy, JobPriority, priorityValue, RETRY_DELAYS_MS, QUEUE_NAMES } from '../queue';

describe('job queue helpers (Issue #27)', () => {
  it('uses the documented retry backoff schedule', () => {
    expect(RETRY_DELAYS_MS).toEqual([5_000, 30_000, 300_000, 1_800_000, 86_400_000]);
    expect(backoffStrategy(1)).toBe(5_000);
    expect(backoffStrategy(2)).toBe(30_000);
    expect(backoffStrategy(3)).toBe(300_000);
    expect(backoffStrategy(4)).toBe(1_800_000);
    expect(backoffStrategy(5)).toBe(86_400_000);
    expect(backoffStrategy(99)).toBe(86_400_000);
  });

  it('maps priority names to bullmq priority numbers (higher = sooner)', () => {
    expect(priorityValue('low')).toBe(JobPriority.low);
    expect(priorityValue('normal')).toBe(JobPriority.normal);
    expect(priorityValue('high')).toBe(JobPriority.high);
    expect(priorityValue('high')).toBeGreaterThan(priorityValue('low'));
  });

  it('exposes the expected queue names including DLQ', () => {
    expect(QUEUE_NAMES.deadLetter).toBe('dead-letter');
    expect(QUEUE_NAMES.email).toBe('email');
    expect(QUEUE_NAMES.analytics).toBe('analytics');
  });
});
