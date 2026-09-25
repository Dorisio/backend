import { Counter, Gauge, Histogram, register } from 'prom-client';
import type { CircuitBreaker, CircuitBreakerState } from './breaker';

/**
 * Prometheus metrics for external-service circuit breakers.
 *
 * All metric names are prefixed with `dorisio_circuit_breaker_` and carry a
 * `name` label identifying the protected integration (e.g. `stellar`), so
 * per-service dashboards and alerts can be built from a single scrape.
 *
 * Metrics are registered idempotently: test suites that reload modules
 * (e.g. `vi.resetModules`) would otherwise hit "already registered" errors
 * against the shared global registry.
 */

const STATE_VALUES: Record<CircuitBreakerState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/** Get the metric already registered under `name`, or create and register it. */
function getOrCreate<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T) ?? create();
}

export const circuitBreakerStateGauge = getOrCreate(
  'dorisio_circuit_breaker_state',
  () =>
    new Gauge({
      name: 'dorisio_circuit_breaker_state',
      help: 'Current circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
      labelNames: ['name'],
    })
);

export const circuitBreakerStateTransitionsTotal = getOrCreate(
  'dorisio_circuit_breaker_state_transitions_total',
  () =>
    new Counter({
      name: 'dorisio_circuit_breaker_state_transitions_total',
      help: 'Total circuit breaker state transitions',
      labelNames: ['name', 'from', 'to'],
    })
);

export const circuitBreakerTripsTotal = getOrCreate(
  'dorisio_circuit_breaker_trips_total',
  () =>
    new Counter({
      name: 'dorisio_circuit_breaker_trips_total',
      help: 'Total times a circuit breaker has tripped to OPEN',
      labelNames: ['name'],
    })
);

export const circuitBreakerCallsTotal = getOrCreate(
  'dorisio_circuit_breaker_calls_total',
  () =>
    new Counter({
      name: 'dorisio_circuit_breaker_calls_total',
      help:
        'Total calls through circuit breakers by outcome (success, failure, timeout, short_circuited, fallback)',
      labelNames: ['name', 'outcome'],
    })
);

export const circuitBreakerCallDuration = getOrCreate(
  'dorisio_circuit_breaker_call_duration_seconds',
  () =>
    new Histogram({
      name: 'dorisio_circuit_breaker_call_duration_seconds',
      help: 'Duration of calls through circuit breakers',
      labelNames: ['name', 'status'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    })
);

/**
 * Sync a breaker's current state into the Prometheus gauge.
 * Safe to call repeatedly; the gauge is simply overwritten.
 */
export function updateCircuitBreakerMetrics(breaker: CircuitBreaker): void {
  circuitBreakerStateGauge.set({ name: breaker.name }, STATE_VALUES[breaker.currentState]);
}

/** Record a state transition on the transitions counter. */
export function recordCircuitBreakerTransition(
  name: string,
  from: CircuitBreakerState,
  to: CircuitBreakerState
): void {
  circuitBreakerStateTransitionsTotal.inc({ name, from, to });
  circuitBreakerStateGauge.set({ name }, STATE_VALUES[to]);
  if (to === 'OPEN') {
    circuitBreakerTripsTotal.inc({ name });
  }
}

/** Record a call outcome on the calls counter. */
export function recordCircuitBreakerCallOutcome(
  name: string,
  outcome: 'success' | 'failure' | 'timeout' | 'short_circuited' | 'fallback'
): void {
  circuitBreakerCallsTotal.inc({ name, outcome });
}

/** Record a call duration observation (seconds). */
export function observeCircuitBreakerCallDuration(
  name: string,
  durationMs: number,
  status: 'success' | 'failure'
): void {
  circuitBreakerCallDuration.observe({ name, status }, durationMs / 1000);
}
