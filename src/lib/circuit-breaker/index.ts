export * from './breaker';
export * from './metrics';
export * from './registry';

import { getBreaker, resetCircuitBreakerRegistry } from './registry';
import { CircuitBreaker, type CircuitBreakerOptions } from './breaker';

/**
 * Convenience wrapper: run `action` through the named breaker, wiring an
 * optional fallback. Call outcomes and latency are recorded by the breaker
 * itself, so no extra instrumentation happens here.
 *
 * Note: the fallback override is applied only when the breaker is first
 * created for this name; existing breakers keep their original options.
 */
export async function executeWithBreaker<T>(
  breakerName: string,
  action: () => Promise<T>,
  options: { fallback?: (error: Error) => T | Promise<T> } = {}
): Promise<T> {
  const breaker = getBreaker(breakerName, {
    overrides: { fallback: options.fallback as never },
  });
  return breaker.execute(action);
}

// ── Compatibility API (formerly src/lib/circuit-breaker.ts) ──────────────────
// The legacy single-file module shadowed this directory module; it was removed
// so only one CircuitBreaker/CircuitBreakerOpenError pair exists. The two
// functions below restore the parts of the legacy API still consumed
// elsewhere (DB health endpoints, metrics route).

/**
 * Returns the process-wide breaker for `name` (legacy signature). Behaves
 * like `getBreaker`; extra options are forwarded as overrides.
 */
export function getCircuitBreaker(
  name: string,
  config: Partial<CircuitBreakerOptions> = {}
): CircuitBreaker {
  return getBreaker(name, { overrides: config });
}

/** Drops every registered breaker (legacy test helper). */
export function resetCircuitBreakers(): void {
  resetCircuitBreakerRegistry();
}
