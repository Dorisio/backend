import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertNotBlockedByFailures,
  cleanupFailureLimiter,
  configureFailureLimiter,
  getFailureCount,
  getFailureStatus,
  isBlockedByFailures,
  recordValidationFailure,
  resetFailureLimiter,
  validationFailureKey,
} from '../failure-limiter';
import { AppError } from '../../utils/errors';

describe('failure limiter', () => {
  beforeEach(() => {
    resetFailureLimiter();
  });

  it('builds a stable key from ip and route', () => {
    expect(validationFailureKey('127.0.0.1', '/api/v1/x')).toBe('127.0.0.1::/api/v1/x');
  });

  it('counts failures and blocks once the threshold is reached', () => {
    configureFailureLimiter({ maxFailures: 3 });
    const key = validationFailureKey('1.1.1.1', '/tip');

    expect(getFailureCount(key)).toBe(0);
    expect(isBlockedByFailures(key)).toBe(false);

    recordValidationFailure(key);
    recordValidationFailure(key);
    expect(isBlockedByFailures(key)).toBe(false);

    recordValidationFailure(key);
    expect(getFailureCount(key)).toBe(3);
    expect(isBlockedByFailures(key)).toBe(true);
  });

  it('throws a 429 AppError once blocked', () => {
    configureFailureLimiter({ maxFailures: 1 });
    const key = validationFailureKey('2.2.2.2', '/tip');
    recordValidationFailure(key);

    try {
      assertNotBlockedByFailures(key);
      throw new Error('expected assertNotBlockedByFailures to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe('RATE_LIMIT_EXCEEDED');
    }
  });

  it('does not throw while under the threshold', () => {
    configureFailureLimiter({ maxFailures: 5 });
    const key = validationFailureKey('3.3.3.3', '/tip');
    recordValidationFailure(key);
    expect(() => assertNotBlockedByFailures(key)).not.toThrow();
  });

  it('reports remaining attempts and reset time', () => {
    configureFailureLimiter({ maxFailures: 5 });
    const key = validationFailureKey('4.4.4.4', '/tip');
    recordValidationFailure(key);
    recordValidationFailure(key);

    const status = getFailureStatus(key);
    expect(status.count).toBe(2);
    expect(status.remaining).toBe(3);
    expect(status.resetAt).not.toBeNull();
  });

  it('expires failures after the window elapses', async () => {
    configureFailureLimiter({ maxFailures: 1, windowMs: 20 });
    const key = validationFailureKey('5.5.5.5', '/tip');
    recordValidationFailure(key);
    expect(isBlockedByFailures(key)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(isBlockedByFailures(key)).toBe(false);
    expect(getFailureStatus(key).remaining).toBe(1);
    expect(cleanupFailureLimiter()).toBe(1);
  });

  it('reset clears all state and configuration', () => {
    configureFailureLimiter({ maxFailures: 1 });
    const key = validationFailureKey('6.6.6.6', '/tip');
    recordValidationFailure(key);
    resetFailureLimiter();

    expect(getFailureCount(key)).toBe(0);
    expect(isBlockedByFailures(key)).toBe(false);
  });
});
