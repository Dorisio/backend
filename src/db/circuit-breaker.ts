import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenSuccessThreshold?: number;
  name?: string;
  onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitBreakerState;
  failures: number;
  consecutiveSuccesses: number;
  tripCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextAttemptTime: number | null;
}

export class DatabaseCircuitBreakerOpenError extends AppError {
  constructor(message = 'Database circuit breaker is OPEN. Fast failing query.') {
    super(503, 'DB_CIRCUIT_BREAKER_OPEN', message);
    this.name = 'DatabaseCircuitBreakerOpenError';
    Object.setPrototypeOf(this, DatabaseCircuitBreakerOpenError.prototype);
  }
}

export class DatabaseCircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failures = 0;
  private consecutiveSuccesses = 0;
  private tripCount = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly name: string;
  private readonly onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'database-pool';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitBreakerState {
    if (this.state === 'OPEN' && this.nextAttemptTime !== null && Date.now() >= this.nextAttemptTime) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      logger.warn(
        { name: this.name, nextAttemptInMs: (this.nextAttemptTime ?? 0) - Date.now() },
        'Circuit breaker is OPEN - refusing DB execution'
      );
      throw new DatabaseCircuitBreakerOpenError(
        `Database service temporarily unavailable for ${this.name}. Circuit breaker is OPEN.`
      );
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

  public recordSuccess(): void {
    this.lastSuccessTime = Date.now();
    const currentState = this.getState();

    if (currentState === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (currentState === 'CLOSED') {
      this.failures = 0;
    }
  }

  public recordFailure(error?: unknown): void {
    this.lastFailureTime = Date.now();
    const currentState = this.getState();

    if (currentState === 'HALF_OPEN') {
      logger.warn(
        { name: this.name, error },
        'Trial execution in HALF_OPEN failed, re-opening circuit breaker'
      );
      this.transitionTo('OPEN');
    } else if (currentState === 'CLOSED') {
      this.failures++;
      logger.warn(
        { name: this.name, failures: this.failures, threshold: this.failureThreshold, error },
        'Database query error recorded in circuit breaker'
      );
      if (this.failures >= this.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  public trip(): void {
    this.transitionTo('OPEN');
  }

  public reset(): void {
    this.transitionTo('CLOSED');
  }

  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    if (newState === 'OPEN') {
      this.tripCount++;
      this.nextAttemptTime = Date.now() + this.resetTimeoutMs;
      this.consecutiveSuccesses = 0;
      logger.error(
        {
          name: this.name,
          tripCount: this.tripCount,
          resetTimeoutMs: this.resetTimeoutMs,
          nextAttemptTime: new Date(this.nextAttemptTime).toISOString(),
        },
        'Database circuit breaker tripped OPEN'
      );
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
      logger.info({ name: this.name }, 'Database circuit breaker entered HALF_OPEN (trial mode)');
    } else if (newState === 'CLOSED') {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
      this.nextAttemptTime = null;
      logger.info({ name: this.name }, 'Database circuit breaker reset to CLOSED');
    }

    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch (err) {
        logger.error({ err }, 'Error in circuit breaker onStateChange callback');
      }
    }
  }

  public getMetrics(): CircuitBreakerMetrics {
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
}
