import { AppError } from '../utils/errors';

/**
 * In-memory sliding-window limiter for failed validation attempts.
 *
 * Repeatedly sending malformed or malicious payloads is a strong signal of
 * probing/abuse, so once a client crosses the threshold for a given route it is
 * temporarily blocked with a 429 before it can hammer the database with more
 * invalid requests.
 */

export const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_MAX_FAILURES = 20;

interface FailureEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, FailureEntry>();

let windowMs = DEFAULT_FAILURE_WINDOW_MS;
let maxFailures = DEFAULT_MAX_FAILURES;

export function validationFailureKey(ip: string, route: string): string {
  return `${ip}::${route}`;
}

/** Overrides the limiter configuration (used by tests). */
export function configureFailureLimiter(options: { windowMs?: number; maxFailures?: number }): void {
  if (options.windowMs !== undefined) windowMs = options.windowMs;
  if (options.maxFailures !== undefined) maxFailures = options.maxFailures;
}

export function recordValidationFailure(key: string): number {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }

  existing.count += 1;
  return existing.count;
}

export function getFailureCount(key: string): number {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    return 0;
  }
  return entry.count;
}

export function isBlockedByFailures(key: string): boolean {
  return getFailureCount(key) >= maxFailures;
}

export function getFailureStatus(key: string): {
  count: number;
  remaining: number;
  resetAt: string | null;
} {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    return { count: 0, remaining: maxFailures, resetAt: null };
  }

  return {
    count: entry.count,
    remaining: Math.max(0, maxFailures - entry.count),
    resetAt: new Date(entry.resetAt).toISOString(),
  };
}

/**
 * Throws a 429 when the caller has exceeded the failure threshold for this key.
 */
export function assertNotBlockedByFailures(key: string): void {
  if (!isBlockedByFailures(key)) {
    return;
  }

  const status = getFailureStatus(key);
  const error = new AppError(
    429,
    'RATE_LIMIT_EXCEEDED',
    'Too many invalid requests. Please try again later.'
  );
  (error as { details?: unknown }).details = { resetAt: status.resetAt };
  throw error;
}

/** Removes expired entries. Safe to call periodically. */
export function cleanupFailureLimiter(): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) {
      store.delete(key);
      removed += 1;
    }
  }

  return removed;
}

export function resetFailureLimiter(): void {
  store.clear();
  windowMs = DEFAULT_FAILURE_WINDOW_MS;
  maxFailures = DEFAULT_MAX_FAILURES;
}
