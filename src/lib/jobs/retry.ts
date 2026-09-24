import { DEFAULT_BACKOFF, JobBackoffOptions } from './types';

export const MAX_BACKOFF_DELAY_MS = 30 * 60 * 1000; // 30 minutes

export interface BackoffOptions {
  /** Adds +/- jitter so retries from many workers do not synchronize. */
  jitter?: boolean;
  maxDelayMs?: number;
  /** Injectable RNG (defaults to Math.random) to keep tests deterministic. */
  random?: () => number;
}

/**
 * Computes the delay before the next attempt.
 *
 * - `fixed`       -> constant delay
 * - `exponential` -> delay * 2^(attempt-1), capped at `maxDelayMs`
 *
 * `attempt` is 1-based (the delay *before* attempt N).
 */
export function computeBackoffDelay(
  attempt: number,
  backoff: JobBackoffOptions = DEFAULT_BACKOFF,
  options: BackoffOptions = {}
): number {
  const maxDelayMs = options.maxDelayMs ?? MAX_BACKOFF_DELAY_MS;
  const safeAttempt = Math.max(1, Math.floor(attempt));

  let delay: number;
  if (backoff.type === 'exponential') {
    delay = backoff.delay * Math.pow(2, safeAttempt - 1);
  } else {
    delay = backoff.delay;
  }

  delay = Math.min(delay, maxDelayMs);

  if (options.jitter) {
    const random = options.random ?? Math.random;
    // Keep between 50% and 100% of the computed delay.
    delay = Math.round(delay * (0.5 + random() * 0.5));
  }

  return Math.max(0, Math.round(delay));
}

/**
 * Returns the full schedule of delays for a job that may be attempted
 * `maxAttempts` times (excluding the first attempt).
 */
export function computeRetrySchedule(
  maxAttempts: number,
  backoff: JobBackoffOptions = DEFAULT_BACKOFF,
  options: BackoffOptions = {}
): number[] {
  const schedule: number[] = [];
  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    schedule.push(computeBackoffDelay(attempt - 1, backoff, options));
  }
  return schedule;
}

export function shouldRetry(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade < maxAttempts;
}

export function attemptsRemaining(attemptsMade: number, maxAttempts: number): number {
  return Math.max(0, maxAttempts - attemptsMade);
}
