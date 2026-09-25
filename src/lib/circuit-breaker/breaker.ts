/**
 * Generic circuit breaker for external service calls.
 *
 * Implements the classic three-state pattern:
 *
 *   CLOSED ---- failures exceed threshold ----> OPEN
 *      ^                                          |
 *      |                                          | resetTimeout elapses
 *      |                                          v
 *   CLOSED <-- halfOpenSuccessThreshold <-- HALF_OPEN
 *
 * - CLOSED: calls pass through; outcomes are recorded in a rolling window.
 *   When the window holds at least `minRequests` outcomes (and the warm-up
 *   `volumeThreshold` has been met), a failure rate at or above
 *   `failureThreshold` trips the circuit OPEN.
 * - OPEN: every call fails fast with a `CircuitBreakerOpenError` without
 *   invoking the wrapped action, until `resetTimeoutMs` elapses.
 * - HALF_OPEN: a single trial call is let through; `halfOpenSuccessThreshold`
 *   consecutive successful trials close the circuit again, while any trial
 *   failure immediately re-opens it.
 *
 * Per-call timeouts are enforced: an action that takes longer than
 * `timeoutMs` is treated as a failure (recorded as a timeout) and its result
 * is discarded.
 */

import {
  observeCircuitBreakerCallDuration,
  recordCircuitBreakerCallOutcome,
  recordCircuitBreakerTransition,
  updateCircuitBreakerMetrics,
} from './metrics';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Human-readable name, used in metrics labels and logs. */
  name?: string;
  /**
   * Failure rate (0-1) of calls in the rolling window that trips the circuit.
   * Default 0.5 (50%), per issue #22.
   */
  failureThreshold?: number;
  /**
   * Consecutive successes required in HALF_OPEN before closing again.
   * Default 2, per issue #22.
   */
  halfOpenSuccessThreshold?: number;
  /**
   * Per-call timeout in milliseconds. Calls slower than this count as
   * failures. Default 60000 (60s), per issue #22.
   */
  timeoutMs?: number;
  /**
   * How long the circuit stays OPEN (ms) before allowing a HALF_OPEN trial.
   * Default 30000.
   */
  resetTimeoutMs?: number;
  /**
   * Minimum number of outcomes in the rolling window before the failure
   * rate is evaluated. Prevents a single early failure from tripping the
   * circuit. Default 5.
   */
  minRequests?: number;
  /** Length of the rolling window (ms) used to compute the failure rate. Default 60000. */
  rollingWindowMs?: number;
  /**
   * Minimum call volume in the current window before the circuit may trip.
   * A warm-up guard so bursty startup traffic does not trip the breaker.
   * Default 5.
   */
  volumeThreshold?: number;
  /** Enable/disable tracking. Disabled breakers pass calls straight through. */
  enabled?: boolean;
  /** Optional fallback invoked when the circuit is OPEN or the call fails. */
  fallback?: (error: Error, ...args: never[]) => unknown;
  /** Notified on every state transition (also drives metrics export). */
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  stats: RollingWindowStats;
  consecutiveSuccesses: number;
  tripCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
  openDurationMs: number | null;
}

export interface RollingWindowStats {
  total: number;
  successes: number;
  failures: number;
  timeouts: number;
  shortCircuited: number;
  failureRate: number;
  fallbacksUsed: number;
  slowCalls: number;
  averageResponseTimeMs: number;
  maxResponseTimeMs: number;
}

/** Error thrown when a call is rejected because the circuit is OPEN. */
export class CircuitBreakerOpenError extends Error {
  public readonly isCircuitBreakerOpen = true;

  constructor(name: string, resetInMs: number) {
    super(
      `Circuit breaker "${name}" is OPEN. Call rejected (retry in ~${Math.max(
        0,
        Math.ceil(resetInMs)
      )}ms).`
    );
    this.name = 'CircuitBreakerOpenError';
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

/** Thrown by `execute` when the wrapped action exceeds `timeoutMs`. */
class CircuitBreakerTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Circuit breaker "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'CircuitBreakerTimeoutError';
    Object.setPrototypeOf(this, CircuitBreakerTimeoutError.prototype);
  }
}

interface Outcome {
  timestamp: number;
  success: boolean;
  durationMs: number;
}

export class CircuitBreaker {
  public readonly name: string;
  public readonly enabled: boolean;

  private state: CircuitBreakerState = 'CLOSED';
  private readonly options: Required<
    Pick<
      CircuitBreakerOptions,
      | 'failureThreshold'
      | 'halfOpenSuccessThreshold'
      | 'timeoutMs'
      | 'resetTimeoutMs'
      | 'minRequests'
      | 'rollingWindowMs'
      | 'volumeThreshold'
    >
  >;
  private readonly fallback: ((error: Error, ...args: never[]) => unknown) | null;
  private readonly onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;

  private window: Outcome[] = [];
  private consecutiveSuccesses = 0;
  private tripCount = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private openedAt: number | null = null;
  private halfOpenTrialInFlight = false;
  private shortCircuitedCount = 0;
  private fallbacksUsedCount = 0;
  private slowCallsCount = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'unnamed';
    this.enabled = options.enabled ?? true;
    this.options = {
      failureThreshold: options.failureThreshold ?? 0.5,
      halfOpenSuccessThreshold: options.halfOpenSuccessThreshold ?? 2,
      timeoutMs: options.timeoutMs ?? 60000,
      resetTimeoutMs: options.resetTimeoutMs ?? 30000,
      minRequests: options.minRequests ?? 5,
      rollingWindowMs: options.rollingWindowMs ?? 60000,
      volumeThreshold: options.volumeThreshold ?? 5,
    };
    this.fallback = options.fallback ?? null;
    const userOnStateChange = options.onStateChange;
    // Every breaker exports its own metrics: state transitions feed the
    // Prometheus counters/gauges, and the user callback (if any) runs after.
    this.onStateChange = (from, to) => {
      recordCircuitBreakerTransition(this.name, from, to);
      if (userOnStateChange) {
        try {
          userOnStateChange(from, to);
        } catch {
          // Never let observer errors break breaker behaviour.
        }
      }
    };
    updateCircuitBreakerMetrics(this);
  }

  /** Current state, lazily transitioning OPEN -> HALF_OPEN once the reset timeout elapsed. */
  get currentState(): CircuitBreakerState {
    if (
      this.state === 'OPEN' &&
      this.nextAttemptTime !== null &&
      Date.now() >= this.nextAttemptTime
    ) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  /**
   * Run `action` under circuit-breaker protection.
   * - Fails fast with `CircuitBreakerOpenError` while OPEN.
   * - Enforces the per-call timeout.
   * - Records the outcome in the rolling window and evaluates thresholds.
   * - Invokes the configured fallback (if any) when open or when the call
   *   fails; otherwise rethrows the original error.
   */
  async execute<T>(action: (...args: never[]) => Promise<T>, ...args: never[]): Promise<T> {
    if (!this.enabled) {
      return action(...args);
    }

    const state = this.currentState;

    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.halfOpenTrialInFlight)) {
      this.shortCircuitedCount++;
      recordCircuitBreakerCallOutcome(this.name, 'short_circuited');
      const resetInMs = Math.max(0, (this.nextAttemptTime ?? Date.now()) - Date.now());
      const openError = new CircuitBreakerOpenError(this.name, resetInMs);
      if (this.fallback) {
        this.fallbacksUsedCount++;
        recordCircuitBreakerCallOutcome(this.name, 'fallback');
        return (await this.fallback(openError, ...args)) as T;
      }
      throw openError;
    }

    const isTrialCall = state === 'HALF_OPEN';
    if (isTrialCall) {
      this.halfOpenTrialInFlight = true;
    }

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        action(...args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CircuitBreakerTimeoutError(this.name, this.options.timeoutMs)),
            this.options.timeoutMs
          );
        }),
      ]);

      const durationMs = Date.now() - startedAt;
      this.recordSuccess(durationMs, isTrialCall);
      recordCircuitBreakerCallOutcome(this.name, 'success');
      observeCircuitBreakerCallDuration(this.name, durationMs, 'success');
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = error instanceof CircuitBreakerTimeoutError;
      this.recordFailure(error, durationMs, isTimeout, isTrialCall);
      recordCircuitBreakerCallOutcome(this.name, 'failure');
      observeCircuitBreakerCallDuration(this.name, durationMs, 'failure');

      if (this.fallback) {
        this.fallbacksUsedCount++;
        recordCircuitBreakerCallOutcome(this.name, 'fallback');
        return (await this.fallback(error as Error, ...args)) as T;
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (isTrialCall) this.halfOpenTrialInFlight = false;
    }
  }

  /**
   * Record a successful call (also usable for manual instrumentation).
   * Re-evaluates the failure threshold so a burst of successes can rescue
   * an otherwise failing window (opossum-style behaviour).
   */
  recordSuccess(durationMs = 0, isTrialCall = this.currentState === 'HALF_OPEN'): void {
    this.lastSuccessTime = Date.now();
    if (durationMs > this.options.timeoutMs / 2) this.slowCallsCount++;
    this.appendOutcome({ timestamp: Date.now(), success: true, durationMs });

    if (isTrialCall) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.options.halfOpenSuccessThreshold) {
        this.transitionTo('CLOSED');
      }
      return;
    }

    if (this.currentState === 'CLOSED') {
      this.evaluateThresholds();
    }
  }

  /** Record a failed call (also usable for manual instrumentation). */
  recordFailure(
    error?: unknown,
    durationMs = 0,
    isTimeout = false,
    isTrialCall = this.currentState === 'HALF_OPEN'
  ): void {
    this.lastFailureTime = Date.now();
    if (isTimeout) this.slowCallsCount++;
    this.appendOutcome({ timestamp: Date.now(), success: false, durationMs });

    if (isTrialCall) {
      // Any failed trial immediately re-opens the circuit.
      this.transitionTo('OPEN');
      return;
    }

    if (this.currentState === 'CLOSED') {
      this.evaluateThresholds();
    }
  }

  /** Manually trip the circuit OPEN (e.g. from a health check). */
  trip(): void {
    if (this.currentState !== 'OPEN') {
      this.transitionTo('OPEN');
    }
  }

  /** Manually close the circuit and clear accumulated stats. */
  close(): void {
    this.transitionTo('CLOSED');
  }

  /** Alias kept for symmetry with the database circuit breaker. */
  reset(): void {
    this.close();
  }

  private appendOutcome(outcome: Outcome): void {
    this.window.push(outcome);
    this.pruneWindow();
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.options.rollingWindowMs;
    while (this.window.length > 0 && this.window[0].timestamp < cutoff) {
      this.window.shift();
    }
  }

  private evaluateThresholds(): void {
    const total = this.window.length;
    if (total < this.options.minRequests) return;
    if (total < this.options.volumeThreshold) return;

    const failures = this.window.filter((o) => !o.success).length;
    const failureRate = failures / total;
    if (failureRate >= this.options.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    if (newState === 'OPEN') {
      this.tripCount++;
      this.openedAt = Date.now();
      this.nextAttemptTime = Date.now() + this.options.resetTimeoutMs;
      this.consecutiveSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
      this.halfOpenTrialInFlight = false;
      this.openedAt = null;
      this.nextAttemptTime = null;
    } else if (newState === 'CLOSED') {
      this.window = [];
      this.consecutiveSuccesses = 0;
      this.nextAttemptTime = null;
      this.openedAt = null;
      this.halfOpenTrialInFlight = false;
    }

    if (this.onStateChange) {
      this.onStateChange(oldState, newState);
    }
  }

  /** Point-in-time rolling-window statistics. */
  getStats(): RollingWindowStats {
    this.pruneWindow();
    const total = this.window.length;
    const successes = this.window.filter((o) => o.success).length;
    const failures = total - successes;
    const sum = this.window.reduce((acc, o) => acc + o.durationMs, 0);
    const max = this.window.reduce((acc, o) => Math.max(acc, o.durationMs), 0);

    return {
      total,
      successes,
      failures,
      timeouts: this.slowCallsCount,
      shortCircuited: this.shortCircuitedCount,
      failureRate: total === 0 ? 0 : failures / total,
      fallbacksUsed: this.fallbacksUsedCount,
      slowCalls: this.slowCallsCount,
      averageResponseTimeMs: total === 0 ? 0 : sum / total,
      maxResponseTimeMs: max,
    };
  }

  /** Full snapshot including state and lifecycle counters. */
  getSnapshot(): CircuitBreakerSnapshot {
    const state = this.currentState;
    return {
      name: this.name,
      state,
      stats: this.getStats(),
      consecutiveSuccesses: this.consecutiveSuccesses,
      tripCount: this.tripCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: state === 'OPEN' ? this.nextAttemptTime : null,
      openDurationMs:
        state === 'OPEN' && this.openedAt !== null ? Date.now() - this.openedAt : null,
    };
  }

  /** Test helper: clears accumulated outcomes and counters without changing state. */
  clearStats(): void {
    this.window = [];
    this.shortCircuitedCount = 0;
    this.fallbacksUsedCount = 0;
    this.slowCallsCount = 0;
  }
}
