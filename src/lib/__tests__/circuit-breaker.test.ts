import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  resetCircuitBreakers,
} from '../circuit-breaker';

/**
 * The rolling-window breaker (issue #22) trips on failure *rate*: the window
 * needs `minRequests` (and `volumeThreshold`) outcomes before it evaluates.
 * These helpers drive enough traffic to cross that warm-up guard.
 */
async function failNTimes(breaker: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await breaker.execute(async () => {
      throw new Error('down');
    }).catch(() => undefined);
  }
}

describe('CircuitBreaker (rolling window)', () => {
  beforeEach(() => {
    resetCircuitBreakers();
  });

  it('passes calls through while closed', async () => {
    const breaker = new CircuitBreaker({ name: 'test' });
    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('opens once the rolling-window failure rate reaches the threshold', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0.5,
      minRequests: 4,
      volumeThreshold: 4,
      resetTimeoutMs: 1000,
    });

    // 2 of 4 failures = 50% → trips at the configured threshold.
    await failNTimes(breaker, 2);
    expect(breaker.currentState).toBe('CLOSED');

    await failNTimes(breaker, 2);
    expect(breaker.currentState).toBe('OPEN');
  });

  it('fails fast without invoking the action while open', async () => {
    const breaker = new CircuitBreaker({ name: 'provider', failureThreshold: 0 });
    breaker.trip();

    const action = vi.fn().mockResolvedValue('never');
    await expect(breaker.execute(action)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(action).not.toHaveBeenCalled();
  });

  it('moves to half-open after the reset timeout and closes on success', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0,
      resetTimeoutMs: 10,
      halfOpenSuccessThreshold: 1,
    });

    breaker.trip();
    expect(breaker.currentState).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.currentState).toBe('HALF_OPEN');

    await breaker.execute(async () => 'recovered');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('re-opens when a half-open trial fails', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 0,
      resetTimeoutMs: 10,
    });

    breaker.trip();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.currentState).toBe('HALF_OPEN');

    await expect(breaker.execute(async () => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down'
    );
    expect(breaker.currentState).toBe('OPEN');
  });

  it('exposes snapshots and state-change callbacks', () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({ name: 'metrics', failureThreshold: 0, onStateChange });

    breaker.trip();

    const snapshot = breaker.getSnapshot();
    expect(snapshot.state).toBe('OPEN');
    expect(snapshot.tripCount).toBe(1);
    expect(onStateChange).toHaveBeenCalledWith('CLOSED', 'OPEN');
  });

  it('supports manual reset (close) and clears stats', () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 0 });
    breaker.trip();
    expect(breaker.currentState).toBe('OPEN');

    breaker.reset();
    expect(breaker.currentState).toBe('CLOSED');
    expect(breaker.getStats().total).toBe(0);
  });

  it('returns a stable breaker per dependency name', () => {
    resetCircuitBreakers();
    const first = getBreakerByName('horizon');
    const second = getBreakerByName('horizon');
    expect(first).toBe(second);
    resetCircuitBreakers();
    expect(getBreakerByName('horizon')).not.toBe(first);
  });
});

import { getBreaker } from '../circuit-breaker';
function getBreakerByName(name: string): CircuitBreaker {
  return getBreaker(name);
}
