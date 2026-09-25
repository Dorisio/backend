import { logger } from '../../utils/logger';
import { config } from '../../config/env';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerSnapshot,
} from './breaker';
import {
  recordCircuitBreakerTransition,
  updateCircuitBreakerMetrics,
} from './metrics';

/**
 * Registry of named circuit breakers protecting external integrations.
 *
 * Breakers are created lazily and cached by name so every call site for a
 * given dependency (e.g. `stellar`) shares one breaker - and therefore one
 * failure-rate history and one OPEN/CLOSED state.
 */

export interface GetBreakerOptions {
  /** Overrides applied on top of the config-derived defaults. */
  overrides?: Partial<CircuitBreakerOptions>;
}

function buildDefaultOptions(name: string): CircuitBreakerOptions {
  const defaults: CircuitBreakerOptions = {
    name,
    failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    halfOpenSuccessThreshold: config.CIRCUIT_BREAKER_SUCCESS_THRESHOLD,
    timeoutMs: config.CIRCUIT_BREAKER_TIMEOUT_MS,
    resetTimeoutMs: config.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    minRequests: config.CIRCUIT_BREAKER_MIN_REQUESTS,
    rollingWindowMs: config.CIRCUIT_BREAKER_ROLLING_WINDOW_MS,
    volumeThreshold: config.CIRCUIT_BREAKER_VOLUME_THRESHOLD,
    enabled: true,
    onStateChange: (from, to) => {
      logger.warn(
        { breaker: name, from, to },
        `Circuit breaker state transition: ${from} -> ${to}`
      );
      recordCircuitBreakerTransition(name, from, to);
    },
  };

  if (name === 'stellar') {
    defaults.enabled = config.STELLAR_CIRCUIT_BREAKER_ENABLED;
    defaults.timeoutMs = config.STELLAR_HORIZON_TIMEOUT_MS;
  }

  return defaults;
}

class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /** Get (or lazily create) the breaker for `name`. */
  getBreaker(name: string, options: GetBreakerOptions = {}): CircuitBreaker {
    const existing = this.breakers.get(name);
    if (existing) {
      return existing;
    }

    const merged: CircuitBreakerOptions = {
      ...buildDefaultOptions(name),
      ...options.overrides,
    };

    const breaker = new CircuitBreaker(merged);
    this.breakers.set(name, breaker);
    updateCircuitBreakerMetrics(breaker);
    logger.debug({ breaker: name, enabled: breaker.enabled }, 'Circuit breaker created');
    return breaker;
  }

  /** All registered breakers keyed by name. */
  getAllBreakers(): Map<string, CircuitBreaker> {
    return this.breakers;
  }

  /** JSON-serialisable snapshots for every registered breaker. */
  getSnapshots(): Record<string, CircuitBreakerSnapshot> {
    const snapshots: Record<string, CircuitBreakerSnapshot> = {};
    for (const [name, breaker] of this.breakers) {
      snapshots[name] = breaker.getSnapshot();
    }
    return snapshots;
  }

  /** Sync all breaker states into the Prometheus gauges (call before scrape). */
  syncMetrics(): void {
    for (const breaker of this.breakers.values()) {
      updateCircuitBreakerMetrics(breaker);
    }
  }

  /** Test helper: drop all registered breakers. */
  reset(): void {
    this.breakers.clear();
  }
}

const registry = new CircuitBreakerRegistry();

export function getBreaker(name: string, options: GetBreakerOptions = {}): CircuitBreaker {
  return registry.getBreaker(name, options);
}

export function getAllBreakers(): Map<string, CircuitBreaker> {
  return registry.getAllBreakers();
}

export function getCircuitBreakerSnapshots(): Record<string, CircuitBreakerSnapshot> {
  return registry.getSnapshots();
}

export function syncCircuitBreakerMetrics(): void {
  registry.syncMetrics();
}

export function resetCircuitBreakerRegistry(): void {
  registry.reset();
}

/** Convenience accessor for the Stellar Horizon breaker. */
export function getStellarBreaker(): CircuitBreaker {
  return registry.getBreaker('stellar');
}
