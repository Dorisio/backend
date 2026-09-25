import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DatabaseCircuitBreaker,
  DatabaseCircuitBreakerOpenError,
} from '../circuit-breaker';

describe('DatabaseCircuitBreaker', () => {
  let cb: DatabaseCircuitBreaker;

  beforeEach(() => {
    vi.useRealTimers();
    cb = new DatabaseCircuitBreaker({
      name: 'test-circuit-breaker',
      failureThreshold: 3,
      resetTimeoutMs: 100,
      halfOpenSuccessThreshold: 2,
    });
  });

  it('should initialize in CLOSED state', () => {
    expect(cb.getState()).toBe('CLOSED');
    const metrics = cb.getMetrics();
    expect(metrics.failures).toBe(0);
    expect(metrics.tripCount).toBe(0);
  });

  it('should execute actions successfully and maintain CLOSED state', async () => {
    const result = await cb.execute(async () => 'success_data');
    expect(result).toBe('success_data');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failures).toBe(0);
    expect(cb.getMetrics().lastSuccessTime).toBeGreaterThan(0);
  });

  it('should trip to OPEN after failure threshold is reached', async () => {
    const failureAction = async () => {
      throw new Error('Connection refused');
    };

    // 1st failure
    await expect(cb.execute(failureAction)).rejects.toThrow('Connection refused');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failures).toBe(1);

    // 2nd failure
    await expect(cb.execute(failureAction)).rejects.toThrow('Connection refused');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failures).toBe(2);

    // 3rd failure -> trips to OPEN
    await expect(cb.execute(failureAction)).rejects.toThrow('Connection refused');
    expect(cb.getState()).toBe('OPEN');
    expect(cb.getMetrics().tripCount).toBe(1);
    expect(cb.getMetrics().lastFailureTime).toBeGreaterThan(0);
  });

  it('should fast-fail when in OPEN state without invoking the action', async () => {
    cb.trip();
    expect(cb.getState()).toBe('OPEN');

    const actionSpy = vi.fn().mockResolvedValue('ok');
    await expect(cb.execute(actionSpy)).rejects.toThrow(/Circuit breaker is OPEN/);
    expect(actionSpy).not.toHaveBeenCalled();
  });

  it('should transition to HALF_OPEN after resetTimeoutMs expires', async () => {
    cb.trip();
    expect(cb.getState()).toBe('OPEN');

    // Wait for reset timeout (100ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('should recover from HALF_OPEN to CLOSED after consecutive successes', async () => {
    cb.trip();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cb.getState()).toBe('HALF_OPEN');

    // 1st success in HALF_OPEN
    await cb.execute(async () => 'trial 1');
    expect(cb.getState()).toBe('HALF_OPEN');

    // 2nd success in HALF_OPEN -> reaches halfOpenSuccessThreshold (2) -> CLOSED
    await cb.execute(async () => 'trial 2');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getMetrics().failures).toBe(0);
  });

  it('should transition back to OPEN if trial execution fails in HALF_OPEN', async () => {
    cb.trip();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cb.getState()).toBe('HALF_OPEN');

    await expect(
      cb.execute(async () => {
        throw new Error('Trial failed');
      })
    ).rejects.toThrow('Trial failed');

    expect(cb.getState()).toBe('OPEN');
    expect(cb.getMetrics().tripCount).toBe(2);
  });

  it('should invoke onStateChange callback during transitions', () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const breaker = new DatabaseCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      onStateChange: (from, to) => {
        transitions.push({ from, to });
      },
    });

    breaker.recordFailure(new Error('fail'));
    expect(transitions).toEqual([{ from: 'CLOSED', to: 'OPEN' }]);

    breaker.reset();
    expect(transitions).toEqual([
      { from: 'CLOSED', to: 'OPEN' },
      { from: 'OPEN', to: 'CLOSED' },
    ]);
  });
});
