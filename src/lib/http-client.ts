import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { DatabaseCircuitBreaker, CircuitBreakerState } from '../db/circuit-breaker';

export interface HttpClientOptions {
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  retryBackoffMultiplier?: number;
  circuitBreakerOptions?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    halfOpenSuccessThreshold?: number;
  };
  headers?: Record<string, string>;
  enableCircuitBreaker?: boolean;
}

export interface RequestOptions extends AxiosRequestConfig {
  idempotencyKey?: string;
  skipRetry?: boolean;
  skipCircuitBreaker?: boolean;
  retries?: number;
}

export interface RetryConfig {
  count: number;
  maxRetries: number;
  delayMs: number;
}

export class HttpClientError extends AppError {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly originalError?: Error
  ) {
    super(statusCode, 'HTTP_CLIENT_ERROR', message);
    this.name = 'HttpClientError';
    Object.setPrototypeOf(this, HttpClientError.prototype);
  }
}

export class HttpClientCircuitBreakerOpenError extends AppError {
  constructor(serviceName: string) {
    super(503, 'HTTP_CIRCUIT_BREAKER_OPEN', `Service ${serviceName} is temporarily unavailable`);
    this.name = 'HttpClientCircuitBreakerOpenError';
    Object.setPrototypeOf(this, HttpClientCircuitBreakerOpenError.prototype);
  }
}

/**
 * Robust HTTP client wrapper with:
 * - Automatic retry with exponential backoff
 * - Configurable timeouts
 * - Circuit breaker pattern
 * - Idempotency key support
 * - Request/response logging and tracing
 * - Rate limit handling (429 responses)
 */
export class HttpClient {
  private client: AxiosInstance;
  private circuitBreaker?: DatabaseCircuitBreaker;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryBackoffMultiplier: number;
  private readonly serviceName: string;

  constructor(options: HttpClientOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.retryBackoffMultiplier = options.retryBackoffMultiplier ?? 2;
    this.serviceName = options.baseURL || 'http-client';

    // Initialize axios instance
    this.client = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeout ?? 10000, // 10s default
      headers: {
        'User-Agent': 'Dorisio-Backend/1.0',
        ...options.headers,
      },
    });

    // Initialize circuit breaker if enabled
    if (options.enableCircuitBreaker !== false) {
      this.circuitBreaker = new DatabaseCircuitBreaker({
        name: this.serviceName,
        failureThreshold: options.circuitBreakerOptions?.failureThreshold ?? 5,
        resetTimeoutMs: options.circuitBreakerOptions?.resetTimeoutMs ?? 30000,
        halfOpenSuccessThreshold: options.circuitBreakerOptions?.halfOpenSuccessThreshold ?? 2,
        onStateChange: (from: CircuitBreakerState, to: CircuitBreakerState) => {
          logger.info(
            { service: this.serviceName, from, to },
            'HTTP client circuit breaker state changed'
          );
        },
      });
    }

    // Setup request interceptor
    this.client.interceptors.request.use(
      (config) => this.handleRequest(config),
      (error) => Promise.reject(error)
    );

    // Setup response interceptor
    this.client.interceptors.response.use(
      (response) => this.handleResponse(response),
      (error) => this.handleResponseError(error)
    );
  }

  /**
   * Request interceptor: adds tracing, idempotency keys, and logs
   */
  private handleRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    const requestId = config.headers?.['X-Request-Id'] || this.generateRequestId();

    // Add request ID for tracing
    config.headers = {
      ...config.headers,
      'X-Request-Id': requestId,
    };

    // Add idempotency key if provided
    const idempotencyKey = (config as any).idempotencyKey;
    if (idempotencyKey) {
      config.headers['Idempotency-Key'] = idempotencyKey;
    }

    logger.debug(
      {
        method: config.method?.toUpperCase(),
        url: config.url,
        requestId,
        hasIdempotencyKey: !!idempotencyKey,
      },
      'HTTP request initiated'
    );

    // Store start time for response logging
    (config as any).startTime = Date.now();

    return config;
  }

  /**
   * Response interceptor: logs successful responses
   */
  private handleResponse(response: AxiosResponse): AxiosResponse {
    const duration = Date.now() - ((response.config as any).startTime || Date.now());

    logger.info(
      {
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
        duration,
        requestId: response.config.headers?.['X-Request-Id'],
      },
      'HTTP request completed'
    );

    return response;
  }

  /**
   * Error interceptor: logs errors and extracts useful info
   */
  private handleResponseError(error: AxiosError): Promise<never> {
    const duration = Date.now() - ((error.config as any)?.startTime || Date.now());

    logger.error(
      {
        method: error.config?.method?.toUpperCase(),
        url: error.config?.url,
        status: error.response?.status,
        duration,
        requestId: error.config?.headers?.['X-Request-Id'],
        message: error.message,
      },
      'HTTP request failed'
    );

    return Promise.reject(error);
  }

  /**
   * Execute HTTP request with retry logic and circuit breaker
   */
  private async executeWithRetry<T>(
    requestFn: () => Promise<AxiosResponse<T>>,
    options: RequestOptions = {}
  ): Promise<AxiosResponse<T>> {
    const maxRetries = options.retries ?? this.maxRetries;
    const skipRetry = options.skipRetry ?? false;
    const skipCircuitBreaker = options.skipCircuitBreaker ?? false;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Check circuit breaker before making request
        if (!skipCircuitBreaker && this.circuitBreaker) {
          const state = this.circuitBreaker.getState();
          if (state === 'OPEN') {
            throw new HttpClientCircuitBreakerOpenError(this.serviceName);
          }
        }

        // Execute request
        const response = await requestFn();

        // Record success in circuit breaker
        if (!skipCircuitBreaker && this.circuitBreaker) {
          this.circuitBreaker.recordSuccess();
        }

        return response;
      } catch (error: any) {
        lastError = error;

        // Record failure in circuit breaker
        if (!skipCircuitBreaker && this.circuitBreaker && this.isRetriableError(error)) {
          this.circuitBreaker.recordFailure(error);
        }

        // Don't retry if skipRetry is enabled or we've exhausted retries
        if (skipRetry || attempt >= maxRetries) {
          break;
        }

        // Don't retry non-retriable errors
        if (!this.isRetriableError(error)) {
          break;
        }

        // Handle rate limiting (429)
        if (this.isRateLimitError(error)) {
          const retryAfter = this.getRetryAfterMs(error);
          logger.warn(
            { attempt, retryAfter, url: error.config?.url },
            'Rate limited, respecting Retry-After header'
          );
          await this.delay(retryAfter);
          continue;
        }

        // Exponential backoff
        const delay = this.calculateBackoffDelay(attempt);
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries,
            delay,
            error: error.message,
            url: error.config?.url,
          },
          'HTTP request failed, retrying with exponential backoff'
        );
        await this.delay(delay);
      }
    }

    // All retries exhausted
    throw new HttpClientError(
      `HTTP request failed after ${maxRetries} retries: ${lastError?.message}`,
      (lastError as any)?.response?.status || 500,
      lastError
    );
  }

  /**
   * Determine if error is retriable
   */
  private isRetriableError(error: any): boolean {
    // Network errors are retriable
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true;
    }

    // Timeout errors are retriable
    if (error.code === 'ECONNABORTED') {
      return true;
    }

    // 5xx errors are retriable
    if (error.response?.status >= 500 && error.response?.status < 600) {
      return true;
    }

    // 429 (rate limit) is retriable
    if (error.response?.status === 429) {
      return true;
    }

    // 408 (request timeout) is retriable
    if (error.response?.status === 408) {
      return true;
    }

    return false;
  }

  /**
   * Check if error is a rate limit error (429)
   */
  private isRateLimitError(error: any): boolean {
    return error.response?.status === 429;
  }

  /**
   * Extract Retry-After header value in milliseconds
   */
  private getRetryAfterMs(error: any): number {
    const retryAfter = error.response?.headers?.['retry-after'];

    if (!retryAfter) {
      return this.retryDelayMs;
    }

    // Retry-After can be seconds (number) or HTTP date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as date
    const retryDate = new Date(retryAfter);
    if (!isNaN(retryDate.getTime())) {
      return Math.max(0, retryDate.getTime() - Date.now());
    }

    return this.retryDelayMs;
  }

  /**
   * Calculate exponential backoff delay
   * Pattern: 1s, 2s, 4s, 8s, 16s
   */
  private calculateBackoffDelay(attempt: number): number {
    return this.retryDelayMs * Math.pow(this.retryBackoffMultiplier, attempt);
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * GET request
   */
  public async get<T = any>(url: string, options?: RequestOptions): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.client.get<T>(url, options), options);
  }

  /**
   * POST request
   */
  public async post<T = any>(
    url: string,
    data?: any,
    options?: RequestOptions
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.client.post<T>(url, data, options), options);
  }

  /**
   * PUT request
   */
  public async put<T = any>(
    url: string,
    data?: any,
    options?: RequestOptions
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.client.put<T>(url, data, options), options);
  }

  /**
   * PATCH request
   */
  public async patch<T = any>(
    url: string,
    data?: any,
    options?: RequestOptions
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.client.patch<T>(url, data, options), options);
  }

  /**
   * DELETE request
   */
  public async delete<T = any>(url: string, options?: RequestOptions): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.client.delete<T>(url, options), options);
  }

  /**
   * Get circuit breaker metrics
   */
  public getCircuitBreakerMetrics() {
    return this.circuitBreaker?.getMetrics();
  }

  /**
   * Reset circuit breaker
   */
  public resetCircuitBreaker(): void {
    this.circuitBreaker?.reset();
  }

  /**
   * Get underlying axios instance for advanced use cases
   */
  public getAxiosInstance(): AxiosInstance {
    return this.client;
  }
}

/**
 * Create a pre-configured HTTP client instance
 */
export function createHttpClient(options?: HttpClientOptions): HttpClient {
  return new HttpClient(options);
}
