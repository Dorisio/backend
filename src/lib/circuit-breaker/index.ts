export * from './breaker';
export * from './metrics';
export * from './registry';

import { getBreaker } from './registry';

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
