/**
 * Retry helper for transient provider failures.
 *
 * Payment providers occasionally return 5xx/timeouts; retrying with exponential
 * backoff avoids surfacing a spurious failure to the user while the provider
 * recovers.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Return false to stop retrying (e.g. for non-retryable errors). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 200;
export const DEFAULT_MAX_DELAY_MS = 5000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), maxDelayMs);
}

/**
 * Runs `operation`, retrying on failure. The final error is rethrown when all
 * attempts are exhausted.
 */
export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      await sleep(computeDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  throw lastError;
}

/**
 * Heuristic for deciding whether a provider error is worth retrying. 4xx
 * responses (except 429) are caller errors and are not retried.
 */
export function isRetryableProviderError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  // Network errors, timeouts and unknown failures are retried.
  return true;
}
