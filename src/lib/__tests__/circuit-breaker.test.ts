import { describe, it, expect, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getCircuitBreaker,
  resetCircuitBreakers,
} from '../circuit-breaker';

describe('CircuitBreaker', () => {
  it('passes calls through while closed', async () => {
    const breaker = new CircuitBreaker({ name: 'test' });
    const result = await breaker.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('opens after reaching the failure threshold', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 2, resetTimeoutMs: 1000 });
    const failing = () => breaker.execute(async () => Promise.reject(new Error('down')));

    await expect(failing()).rejects.toThrow('down');
    expect(breaker.getState()).toBe('CLOSED');

    await expect(failing()).rejects.toThrow('down');
    expect(breaker.getState()).toBe('OPEN');
  });

  it('fails fast without invoking the action while open', async () => {
    const breaker = new CircuitBreaker({ name: 'provider', failureThreshold: 1 });
    breaker.trip();

    const action = vi.fn().mockResolvedValue('never');
    await expect(breaker.execute(action)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    expect(action).not.toHaveBeenCalled();
  });

  it('moves to half-open after the reset timeout and closes on success', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 10,
      halfOpenSuccessThreshold: 1,
    });

    breaker.trip();
    expect(breaker.getState()).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.getState()).toBe('HALF_OPEN');

    await breaker.execute(async () => 'recovered');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('re-opens when a half-open trial fails', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });

    breaker.trip();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(breaker.getState()).toBe('HALF_OPEN');

    await expect(breaker.execute(async () => Promise.reject(new Error('still down')))).rejects.toThrow(
      'still down'
    );
    expect(breaker.getState()).toBe('OPEN');
  });

  it('exposes metrics and state-change callbacks', () => {
    const onStateChange = vi.fn();
    const breaker = new CircuitBreaker({ name: 'metrics', failureThreshold: 1, onStateChange });

    breaker.trip();

    const metrics = breaker.getMetrics();
    expect(metrics.state).toBe('OPEN');
    expect(metrics.tripCount).toBe(1);
    expect(onStateChange).toHaveBeenCalledWith('CLOSED', 'OPEN');
  });

  it('supports manual reset', () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    breaker.trip();
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getMetrics().failures).toBe(0);
  });

  it('returns a stable breaker per dependency name', () => {
    resetCircuitBreakers();
    const first = getCircuitBreaker('horizon');
    const second = getCircuitBreaker('horizon');
    expect(first).toBe(second);
    resetCircuitBreakers();
    expect(getCircuitBreaker('horizon')).not.toBe(first);
  });
});
