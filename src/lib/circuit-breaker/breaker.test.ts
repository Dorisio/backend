import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { register } from 'prom-client';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerState,
} from './breaker';
import {
  executeWithBreaker,
  getBreaker,
  getCircuitBreakerSnapshots,
  resetCircuitBreakerRegistry,
} from './index';

function ok<T>(value: T): () => Promise<T> {
  return async () => value;
}

function boom(message = 'external service failed'): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

/** Build a breaker with small thresholds for fast tests. */
function makeBreaker(
  overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}
): CircuitBreaker {
  return new CircuitBreaker({
    name: 'test',
    failureThreshold: 0.5,
    halfOpenSuccessThreshold: 2,
    timeoutMs: 200,
    resetTimeoutMs: 100,
    minRequests: 4,
    rollingWindowMs: 5000,
    volumeThreshold: 4,
    ...overrides,
  });
}

/** Record `fails` failures followed by `succeeds` successes through the breaker. */
async function drive(breaker: CircuitBreaker, fails: number, succeeds: number): Promise<void> {
  for (let i = 0; i < fails; i++) {
    await breaker.execute(boom()).catch(() => undefined);
  }
  for (let i = 0; i < succeeds; i++) {
    await breaker.execute(ok('ok')).catch(() => undefined);
  }
}

/**
 * Trip the breaker OPEN through real call outcomes: with the default
 * thresholds (minRequests=4, failureThreshold=0.5) the 4th outcome reaches
 * exactly 2/4 = 50% and trips the circuit.
 */
async function tripOpen(breaker: CircuitBreaker): Promise<void> {
  await drive(breaker, 2, 2);
  expect(breaker.currentState).toBe('OPEN');
}

/** Read the current value of a labelled metric from the default registry. */
async function metricValue(
  metricName: string,
  labels: Record<string, string>
): Promise<number | undefined> {
  const json = await register.getMetricsAsJSON();
  const metric = json.find((m) => m.name === metricName) as
    | { values: Array<{ value: number; labels?: Record<string, string> }> }
    | undefined;
  return metric?.values.find((v) => {
    for (const [key, label] of Object.entries(labels)) {
      if (v.labels?.[key] !== label) return false;
    }
    return true;
  })?.value;
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('circuit closed: requests succeed', () => {
    it('starts CLOSED and passes calls through', async () => {
      const breaker = makeBreaker();

      expect(breaker.currentState).toBe<CircuitBreakerState>('CLOSED');
      expect(await breaker.execute(ok('value'))).toBe('value');
      expect(breaker.currentState).toBe('CLOSED');
    });

    it('stays CLOSED while failure rate is below threshold', async () => {
      const breaker = makeBreaker();

      // 4 calls: 1 failure = 25% < 50%
      await drive(breaker, 1, 3);

      expect(breaker.currentState).toBe('CLOSED');
      expect(breaker.getStats().failureRate).toBe(0.25);
    });

    it('does not trip before minRequests outcomes are recorded', async () => {
      const breaker = makeBreaker({ minRequests: 6, volumeThreshold: 6 });

      // 5/5 failures = 100% but below minRequests/volume threshold
      await drive(breaker, 5, 0);

      expect(breaker.currentState).toBe('CLOSED');
    });
  });

  describe('circuit opens: threshold exceeded', () => {
    it('trips OPEN when failure rate reaches the threshold', async () => {
      const breaker = makeBreaker();

      // 4 calls: 2 failures = 50% >= threshold -> trips
      await tripOpen(breaker);

      expect(breaker.getSnapshot().tripCount).toBe(1);
      expect(breaker.getSnapshot().lastFailureTime).not.toBeNull();
    });

    it('fails fast while OPEN without invoking the action', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);

      const action = vi.fn(ok('never'));
      await expect(breaker.execute(action)).rejects.toThrow(CircuitBreakerOpenError);
      await expect(breaker.execute(action)).rejects.toThrow(/is OPEN/);
      expect(action).not.toHaveBeenCalled();
      expect(breaker.getStats().shortCircuited).toBe(2);
    });

    it('respects a configurable failure threshold', async () => {
      const breaker = makeBreaker({ failureThreshold: 0.8, minRequests: 5, volumeThreshold: 5 });

      // 4 failures out of 5 = 80% -> trips
      await drive(breaker, 4, 1);
      expect(breaker.currentState).toBe('OPEN');

      // With a stricter threshold (100%), 4/5 failures do NOT trip.
      const strict = makeBreaker({ failureThreshold: 1, minRequests: 5, volumeThreshold: 5 });
      await drive(strict, 4, 1);
      expect(strict.currentState).toBe('CLOSED');
    });

    it('ignores outcomes older than the rolling window', async () => {
      const breaker = makeBreaker({ rollingWindowMs: 1000 });

      // 2 failures: below minRequests so nothing trips.
      await drive(breaker, 2, 0);
      expect(breaker.currentState).toBe('CLOSED');

      // Let the rolling window expire; the two failures fall out of scope.
      vi.advanceTimersByTime(1500);

      // Two successes: window holds 2 successes, 0 failures.
      await drive(breaker, 0, 2);
      expect(breaker.currentState).toBe('CLOSED');
      expect(breaker.getStats().total).toBe(2);
      expect(breaker.getStats().failures).toBe(0);
    });
  });

  describe('circuit half-open: tries recovery', () => {
    it('moves to HALF_OPEN after resetTimeout elapses', async () => {
      const breaker = makeBreaker({ resetTimeoutMs: 100 });
      await tripOpen(breaker);

      vi.advanceTimersByTime(101);
      expect(breaker.currentState).toBe('HALF_OPEN');
    });

    it('allows a single trial call through in HALF_OPEN', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);
      vi.advanceTimersByTime(150);

      expect(await breaker.execute(ok('trial'))).toBe('trial');
    });

    it('fails fast for concurrent calls while a trial is in flight', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);
      vi.advanceTimersByTime(150);

      const slowTrial = () =>
        new Promise((resolve) => setTimeout(() => resolve('trial'), 50));
      const trial = breaker.execute(slowTrial);

      const rejected = breaker.execute(ok('should be rejected'));
      await expect(rejected).rejects.toThrow(CircuitBreakerOpenError);

      vi.advanceTimersByTime(60);
      await expect(trial).resolves.toBe('trial');
    });
  });

  describe('circuit closes: recovery successful', () => {
    it('closes after the configured consecutive successes in HALF_OPEN', async () => {
      const breaker = makeBreaker({ halfOpenSuccessThreshold: 2 });
      await tripOpen(breaker);
      vi.advanceTimersByTime(150);
      expect(breaker.currentState).toBe('HALF_OPEN');

      await breaker.execute(ok('trial 1'));
      expect(breaker.currentState).toBe('HALF_OPEN');

      await breaker.execute(ok('trial 2'));
      expect(breaker.currentState).toBe('CLOSED');
    });

    it('re-opens immediately when the trial call fails', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);
      vi.advanceTimersByTime(150);
      expect(breaker.currentState).toBe('HALF_OPEN');

      await expect(breaker.execute(boom('still down'))).rejects.toThrow('still down');
      expect(breaker.currentState).toBe('OPEN');
      expect(breaker.getSnapshot().tripCount).toBe(2);
    });

    it('clears failure statistics after closing', async () => {
      const breaker = makeBreaker({ halfOpenSuccessThreshold: 1 });
      await tripOpen(breaker);
      vi.advanceTimersByTime(150);

      await breaker.execute(ok('recovered'));
      expect(breaker.currentState).toBe('CLOSED');
      expect(breaker.getStats().failures).toBe(0);
      expect(breaker.getStats().failureRate).toBe(0);
    });
  });

  describe('fallback response when open', () => {
    it('returns the fallback value instead of throwing while OPEN', async () => {
      const breaker = makeBreaker({
        fallback: () => ({ cached: true, source: 'fallback' }) as never,
      });
      await tripOpen(breaker);

      const result = await breaker.execute(ok('never called'));
      expect(result).toEqual({ cached: true, source: 'fallback' });
    });

    it('uses the fallback for failed calls when the service errors', async () => {
      const breaker = makeBreaker({
        fallback: (error) => ({ degraded: true, reason: error.message }) as never,
      });

      const result = await breaker.execute(boom('horizon down'));
      expect(result).toEqual({ degraded: true, reason: 'horizon down' });
    });

    it('counts fallback usage in stats', async () => {
      const breaker = makeBreaker({ fallback: () => 'fallback' as never });

      // tripOpen: the 2 failing calls use the fallback, the 2 successes trip it.
      await tripOpen(breaker);
      expect(breaker.getStats().fallbacksUsed).toBe(2);

      // 2 more calls rejected while OPEN also fall back.
      await breaker.execute(ok('x'));
      await breaker.execute(ok('x'));
      expect(breaker.getStats().fallbacksUsed).toBe(4);
    });

    it('throws CircuitBreakerOpenError when no fallback is configured', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);

      await expect(breaker.execute(ok('x'))).rejects.toThrow(CircuitBreakerOpenError);
    });
  });

  describe('timeout enforced', () => {
    it('treats a call exceeding timeoutMs as a failure', async () => {
      const breaker = makeBreaker({ timeoutMs: 50 });
      const promise = breaker.execute(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 500))
      );

      // Advance past the timeout; the rejected race wins.
      vi.advanceTimersByTime(60);
      await expect(promise).rejects.toThrow(/timed out after 50ms/);
      expect(breaker.getStats().failures).toBe(1);
    });

    it('records timeouts as slow calls in stats', async () => {
      const breaker = makeBreaker({ timeoutMs: 50 });
      const promise = breaker.execute(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 500))
      );

      vi.advanceTimersByTime(60);
      await promise.catch(() => undefined);

      expect(breaker.getStats().slowCalls).toBe(1);
      expect(breaker.getStats().timeouts).toBe(1);
    });

    it('does not leak the timer when the call succeeds first', async () => {
      const breaker = makeBreaker({ timeoutMs: 100 });

      const result = await breaker.execute(ok('fast'));
      expect(result).toBe('fast');

      // If the timer leaked, advancing time would reject a dangling promise
      // and trip the breaker via a phantom failure.
      vi.advanceTimersByTime(200);
      expect(breaker.getStats().failures).toBe(0);
      expect(breaker.currentState).toBe('CLOSED');
    });
  });

  describe('configuration working', () => {
    it('applies all provided options', () => {
      const breaker = new CircuitBreaker({
        name: 'custom',
        failureThreshold: 0.3,
        halfOpenSuccessThreshold: 5,
        timeoutMs: 1234,
        resetTimeoutMs: 4321,
        minRequests: 10,
        rollingWindowMs: 30000,
        volumeThreshold: 8,
      });

      expect(breaker.name).toBe('custom');
      expect(breaker.getSnapshot().state).toBe('CLOSED');
    });

    it('uses issue #22 defaults when constructed without options', async () => {
      const breaker = new CircuitBreaker();
      expect(breaker.name).toBe('unnamed');

      // 60s timeout: a call taking longer than 60s should fail.
      const promise = breaker.execute(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 61000))
      );
      vi.advanceTimersByTime(60001);
      await expect(promise).rejects.toThrow(/timed out after 60000ms/);
    });

    it('can be disabled to pass calls straight through', async () => {
      const breaker = makeBreaker({ enabled: false });
      const action = vi.fn(ok('passthrough'));

      await drive(breaker, 10, 0);
      expect(breaker.currentState).toBe('CLOSED');

      expect(await breaker.execute(action)).toBe('passthrough');
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('notifies onStateChange for every transition', async () => {
      const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
      const breaker = makeBreaker({
        halfOpenSuccessThreshold: 1,
        onStateChange: (from, to) => transitions.push([from, to]),
      });

      await tripOpen(breaker); // CLOSED -> OPEN
      vi.advanceTimersByTime(150); // -> HALF_OPEN (lazy)
      expect(breaker.currentState).toBe('HALF_OPEN');
      await breaker.execute(ok('recovered')); // -> CLOSED

      expect(transitions).toEqual([
        ['CLOSED', 'OPEN'],
        ['OPEN', 'HALF_OPEN'],
        ['HALF_OPEN', 'CLOSED'],
      ]);
    });

    it('swallows observer errors thrown by onStateChange', async () => {
      const breaker = makeBreaker({
        onStateChange: () => {
          throw new Error('observer exploded');
        },
      });

      await tripOpen(breaker);
      expect(breaker.currentState).toBe('OPEN');
    });
  });

  describe('metrics updated correctly', () => {
    it('exposes stats via getStats and getSnapshot', async () => {
      const breaker = makeBreaker();
      await drive(breaker, 1, 3);

      const stats = breaker.getStats();
      expect(stats.total).toBe(4);
      expect(stats.successes).toBe(3);
      expect(stats.failures).toBe(1);
      expect(stats.failureRate).toBe(0.25);
      expect(stats.averageResponseTimeMs).toBeGreaterThanOrEqual(0);
      expect(stats.maxResponseTimeMs).toBeGreaterThanOrEqual(0);

      const snapshot = breaker.getSnapshot();
      expect(snapshot.name).toBe('test');
      expect(snapshot.state).toBe('CLOSED');
      expect(snapshot.tripCount).toBe(0);
      expect(snapshot.lastSuccessTime).not.toBeNull();
      expect(snapshot.lastFailureTime).not.toBeNull();
    });

    it('tracks short-circuited calls and trip count while open', async () => {
      const breaker = makeBreaker();
      await tripOpen(breaker);
      await breaker.execute(ok('x')).catch(() => undefined);

      const snapshot = breaker.getSnapshot();
      expect(snapshot.state).toBe('OPEN');
      expect(snapshot.tripCount).toBe(1);
      expect(snapshot.nextAttemptTime).not.toBeNull();
      expect(snapshot.stats.shortCircuited).toBe(1);
    });

    it('exports breaker state to the Prometheus gauge', async () => {
      const breaker = makeBreaker({ name: 'prom-test' });
      expect(await metricValue('dorisio_circuit_breaker_state', { name: 'prom-test' })).toBe(0);

      breaker.trip();
      expect(await metricValue('dorisio_circuit_breaker_state', { name: 'prom-test' })).toBe(2); // OPEN
    });

    it('increments trips counter when a breaker opens', async () => {
      const breaker = makeBreaker({ name: 'trips-test' });
      const before = (await metricValue('dorisio_circuit_breaker_trips_total', { name: 'trips-test' })) ?? 0;

      await tripOpen(breaker);

      const after = (await metricValue('dorisio_circuit_breaker_trips_total', { name: 'trips-test' })) ?? 0;
      expect(after).toBe(before + 1);
    });

    it('increments transitions counter with from/to labels', async () => {
      const labels = { name: 'trans-test', from: 'CLOSED', to: 'OPEN' };
      const before = (await metricValue('dorisio_circuit_breaker_state_transitions_total', labels)) ?? 0;

      const breaker = makeBreaker({ name: 'trans-test' });
      await tripOpen(breaker);

      const after = (await metricValue('dorisio_circuit_breaker_state_transitions_total', labels)) ?? 0;
      expect(after).toBe(before + 1);
    });

    it('counts call outcomes on the calls counter', async () => {
      const name = 'calls-test';
      const breaker = makeBreaker({ name });

      const successBefore = (await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'success' })) ?? 0;
      const failureBefore = (await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'failure' })) ?? 0;
      const shortBefore = (await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'short_circuited' })) ?? 0;

      await drive(breaker, 3, 1); // 1 success, 3 failures; 4th outcome trips OPEN at 75%
      await breaker.execute(ok('x')).catch(() => undefined); // short-circuited

      expect(
        ((await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'success' })) ?? 0) -
          successBefore
      ).toBe(1);
      expect(
        ((await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'failure' })) ?? 0) -
          failureBefore
      ).toBe(3);
      expect(
        ((await metricValue('dorisio_circuit_breaker_calls_total', { name, outcome: 'short_circuited' })) ?? 0) -
          shortBefore
      ).toBe(1);
    });
  });
});

describe('circuit breaker registry', () => {
  afterEach(() => {
    resetCircuitBreakerRegistry();
  });

  it('returns the same breaker instance for the same name', () => {
    const a = getBreaker('singleton-test');
    const b = getBreaker('singleton-test');
    expect(a).toBe(b);
  });

  it('creates separate breakers per integration name', () => {
    const a = getBreaker('svc-a');
    const b = getBreaker('svc-b');
    expect(a).not.toBe(b);
  });

  it('exports snapshots for all registered breakers', () => {
    getBreaker('snap-a');
    getBreaker('snap-b');

    const snapshots = getCircuitBreakerSnapshots();
    expect(Object.keys(snapshots).sort()).toEqual(['snap-a', 'snap-b']);
    expect(snapshots['snap-a'].state).toBe('CLOSED');
  });
});

describe('executeWithBreaker', () => {
  afterEach(() => {
    resetCircuitBreakerRegistry();
  });

  it('returns the action result and records success metrics', async () => {
    const result = await executeWithBreaker('exec-test', ok('done'));
    expect(result).toBe('done');
    expect(await metricValue('dorisio_circuit_breaker_calls_total', { name: 'exec-test', outcome: 'success' })).toBe(1);
  });

  it('rethrows action errors and records failure metrics', async () => {
    await expect(executeWithBreaker('exec-err', boom())).rejects.toThrow('external service failed');
    expect(await metricValue('dorisio_circuit_breaker_calls_total', { name: 'exec-err', outcome: 'failure' })).toBe(1);
  });

  it('supports a fallback invoked when the circuit is open', async () => {
    // Pre-create the breaker with the fallback (registry ignores overrides
    // for existing breakers, so it must be present from the start).
    const breaker = getBreaker('exec-fallback', {
      overrides: { fallback: (() => 'fallback-value') as never },
    });
    breaker.trip();

    const result = await executeWithBreaker('exec-fallback', ok('never'), {
      fallback: () => 'fallback-value',
    });

    expect(result).toBe('fallback-value');
    expect(
      await metricValue('dorisio_circuit_breaker_calls_total', {
        name: 'exec-fallback',
        outcome: 'short_circuited',
      })
    ).toBe(1);
  });
});
