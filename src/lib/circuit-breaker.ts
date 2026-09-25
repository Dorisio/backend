import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Generic circuit breaker used to fail fast when an external dependency
 * (payment provider, email provider, Horizon, ...) starts erroring, instead of
 * letting background jobs pile up waiting on a dead service.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name?: string;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenSuccessThreshold?: number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: BreakerState;
  failures: number;
  consecutiveSuccesses: number;
  tripCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

export class CircuitBreakerOpenError extends AppError {
  constructor(service: string) {
    super(
      503,
      'CIRCUIT_BREAKER_OPEN',
      `${service} is temporarily unavailable. Please try again shortly.`
    );
    this.name = 'CircuitBreakerOpenError';
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private consecutiveSuccesses = 0;
  private tripCount = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly onStateChange?: (from: BreakerState, to: BreakerState) => void;

  constructor(config: CircuitBreakerConfig = {}) {
    this.name = config.name ?? 'external-service';
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 2;
    this.onStateChange = config.onStateChange;
  }

  getState(): BreakerState {
    if (
      this.state === 'OPEN' &&
      this.nextAttemptTime !== null &&
      Date.now() >= this.nextAttemptTime
    ) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    if (this.getState() === 'OPEN') {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    const state = this.getState();

    if (state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (state === 'CLOSED') {
      this.failures = 0;
    }
  }

  recordFailure(error?: unknown): void {
    this.lastFailureTime = Date.now();
    const state = this.getState();

    if (state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
      return;
    }

    if (state === 'CLOSED') {
      this.failures += 1;
      logger.warn(
        { name: this.name, failures: this.failures, threshold: this.failureThreshold, error },
        'Circuit breaker recorded a failure'
      );
      if (this.failures >= this.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  trip(): void {
    this.transitionTo('OPEN');
  }

  reset(): void {
    this.transitionTo('CLOSED');
  }

  getMetrics(): CircuitBreakerMetrics {
    return {
      name: this.name,
      state: this.getState(),
      failures: this.failures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      tripCount: this.tripCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  private transitionTo(newState: BreakerState): void {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }

    this.state = newState;

    if (newState === 'OPEN') {
      this.tripCount += 1;
      this.nextAttemptTime = Date.now() + this.resetTimeoutMs;
      this.consecutiveSuccesses = 0;
      logger.error(
        { name: this.name, tripCount: this.tripCount, resetTimeoutMs: this.resetTimeoutMs },
        'Circuit breaker tripped OPEN'
      );
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
    } else {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
      this.nextAttemptTime = null;
    }

    this.onStateChange?.(oldState, newState);
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** Returns a process-wide circuit breaker for a named dependency. */
export function getCircuitBreaker(name: string, config: CircuitBreakerConfig = {}): CircuitBreaker {
  const existing = breakers.get(name);
  if (existing) {
    return existing;
  }
  const breaker = new CircuitBreaker({ ...config, name });
  breakers.set(name, breaker);
  return breaker;
}

export function resetCircuitBreakers(): void {
  breakers.clear();
}
