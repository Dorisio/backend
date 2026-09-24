import { describe, it, expect } from 'vitest';
import { attemptsRemaining, computeBackoffDelay, computeRetrySchedule, shouldRetry } from '../retry';

describe('computeBackoffDelay', () => {
  it('returns a constant delay for fixed backoff', () => {
    const backoff = { type: 'fixed' as const, delay: 500 };
    expect(computeBackoffDelay(1, backoff)).toBe(500);
    expect(computeBackoffDelay(5, backoff)).toBe(500);
  });

  it('grows exponentially for exponential backoff', () => {
    const backoff = { type: 'exponential' as const, delay: 1000 };
    expect(computeBackoffDelay(1, backoff)).toBe(1000);
    expect(computeBackoffDelay(2, backoff)).toBe(2000);
    expect(computeBackoffDelay(3, backoff)).toBe(4000);
  });

  it('caps the delay at the configured maximum', () => {
    const backoff = { type: 'exponential' as const, delay: 1000 };
    expect(computeBackoffDelay(20, backoff, { maxDelayMs: 5000 })).toBe(5000);
  });

  it('applies jitter within the 50-100% band', () => {
    const backoff = { type: 'exponential' as const, delay: 1000 };
    expect(computeBackoffDelay(1, backoff, { jitter: true, random: () => 0 })).toBe(500);
    expect(computeBackoffDelay(1, backoff, { jitter: true, random: () => 1 })).toBe(1000);
  });

  it('treats attempts below 1 as the first attempt', () => {
    const backoff = { type: 'exponential' as const, delay: 100 };
    expect(computeBackoffDelay(0, backoff)).toBe(100);
    expect(computeBackoffDelay(-3, backoff)).toBe(100);
  });
});

describe('computeRetrySchedule', () => {
  it('produces a delay per retry', () => {
    const schedule = computeRetrySchedule(4, { type: 'exponential', delay: 100 });
    expect(schedule).toEqual([100, 200, 400]);
  });

  it('returns an empty schedule when there are no retries', () => {
    expect(computeRetrySchedule(1)).toEqual([]);
  });
});

describe('retry predicates', () => {
  it('decides whether another attempt is allowed', () => {
    expect(shouldRetry(0, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
    expect(shouldRetry(3, 3)).toBe(false);
    expect(shouldRetry(4, 3)).toBe(false);
  });

  it('reports attempts remaining', () => {
    expect(attemptsRemaining(1, 3)).toBe(2);
    expect(attemptsRemaining(5, 3)).toBe(0);
  });
});
