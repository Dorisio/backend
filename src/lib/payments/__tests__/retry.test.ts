import { describe, it, expect, vi } from 'vitest';
import { computeDelay, isRetryableProviderError, retryOperation } from '../retry';

const noSleep = async (): Promise<void> => undefined;

describe('retryOperation', () => {
  it('returns the result on the first success', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(retryOperation(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to the attempt limit', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('third');

    await expect(retryOperation(operation, { attempts: 3, sleep: noSleep })).resolves.toBe('third');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('always'));
    await expect(retryOperation(operation, { attempts: 2, sleep: noSleep })).rejects.toThrow('always');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when shouldRetry returns false', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      retryOperation(operation, { attempts: 5, sleep: noSleep, shouldRetry: () => false })
    ).rejects.toThrow('fatal');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };

    await expect(
      retryOperation(vi.fn().mockRejectedValue(new Error('x')), {
        attempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep,
      })
    ).rejects.toThrow('x');

    expect(delays).toEqual([100, 200, 400]);
  });
});

describe('computeDelay', () => {
  it('caps the delay at the maximum', () => {
    expect(computeDelay(10, 100, 1000)).toBe(1000);
  });
});

describe('isRetryableProviderError', () => {
  it('retries 5xx and 429 responses', () => {
    expect(isRetryableProviderError({ response: { status: 500 } })).toBe(true);
    expect(isRetryableProviderError({ response: { status: 429 } })).toBe(true);
  });

  it('does not retry other 4xx responses', () => {
    expect(isRetryableProviderError({ response: { status: 400 } })).toBe(false);
    expect(isRetryableProviderError({ response: { status: 402 } })).toBe(false);
  });

  it('retries network errors without a status', () => {
    expect(isRetryableProviderError(new Error('ECONNRESET'))).toBe(true);
  });
});
