import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import axios from 'axios';
import { HttpClient, HttpClientError, HttpClientCircuitBreakerOpenError } from '../http-client';

// Mock axios
vi.mock('axios');

describe('HttpClient', () => {
  let mockAxiosInstance: any;
  let mockCreate: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: {
          use: vi.fn((successFn) => {
            mockAxiosInstance._requestInterceptor = successFn;
            return 0;
          }),
        },
        response: {
          use: vi.fn((successFn, errorFn) => {
            mockAxiosInstance._responseSuccessInterceptor = successFn;
            mockAxiosInstance._responseErrorInterceptor = errorFn;
            return 0;
          }),
        },
      },
    };

    mockCreate = vi.mocked(axios.create);
    mockCreate.mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should create axios instance with default options', () => {
      new HttpClient();

      expect(mockCreate).toHaveBeenCalledWith({
        baseURL: undefined,
        timeout: 10000,
        headers: {
          'User-Agent': 'Dorisio-Backend/1.0',
        },
      });
    });

    it('should create axios instance with custom options', () => {
      new HttpClient({
        baseURL: 'https://api.example.com',
        timeout: 5000,
        headers: { 'Custom-Header': 'value' },
      });

      expect(mockCreate).toHaveBeenCalledWith({
        baseURL: 'https://api.example.com',
        timeout: 5000,
        headers: {
          'User-Agent': 'Dorisio-Backend/1.0',
          'Custom-Header': 'value',
        },
      });
    });

    it('should setup request and response interceptors', () => {
      new HttpClient();

      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });
  });

  describe('Successful Requests', () => {
    it('should make successful GET request', async () => {
      const client = new HttpClient();
      const mockResponse = { data: { id: 1 }, status: 200, config: {} };
      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const response = await client.get('/users');

      expect(response.data).toEqual({ id: 1 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users', undefined);
    });

    it('should make successful POST request', async () => {
      const client = new HttpClient();
      const mockResponse = { data: { created: true }, status: 201, config: {} };
      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const response = await client.post('/users', { name: 'John' });

      expect(response.data).toEqual({ created: true });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/users', { name: 'John' }, undefined);
    });

    it('should make successful PUT request', async () => {
      const client = new HttpClient();
      const mockResponse = { data: { updated: true }, status: 200, config: {} };
      mockAxiosInstance.put.mockResolvedValue(mockResponse);

      await client.put('/users/1', { name: 'Jane' });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/users/1', { name: 'Jane' }, undefined);
    });

    it('should make successful DELETE request', async () => {
      const client = new HttpClient();
      const mockResponse = { data: {}, status: 204, config: {} };
      mockAxiosInstance.delete.mockResolvedValue(mockResponse);

      await client.delete('/users/1');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/users/1', undefined);
    });
  });

  describe('Request Interceptor', () => {
    it('should add request ID to headers', async () => {
      const client = new HttpClient();
      const mockResponse = { data: {}, status: 200, config: {} };
      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await client.get('/test');

      const interceptor = mockAxiosInstance._requestInterceptor;
      const config = interceptor({ headers: {} });

      expect(config.headers['X-Request-Id']).toBeTruthy();
      expect(config.headers['X-Request-Id']).toMatch(/^req_/);
    });

    it('should add idempotency key when provided', async () => {
      const client = new HttpClient();
      const mockResponse = { data: {}, status: 200, config: {} };
      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await client.post('/payments', { amount: 100 }, { idempotencyKey: 'key-123' });

      const interceptor = mockAxiosInstance._requestInterceptor;
      const config = interceptor({ headers: {}, idempotencyKey: 'key-123' });

      expect(config.headers['Idempotency-Key']).toBe('key-123');
    });
  });

  describe('Retry Logic', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should retry on 500 error with exponential backoff', async () => {
      const client = new HttpClient({ maxRetries: 2, retryDelayMs: 100 });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');

      // First retry after 100ms (1 * 100 * 2^0)
      await vi.advanceTimersByTimeAsync(100);

      // Second retry after 200ms (1 * 100 * 2^1)
      await vi.advanceTimersByTimeAsync(200);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
    });

    it('should retry on network errors', async () => {
      const client = new HttpClient({ maxRetries: 1, retryDelayMs: 100 });
      const networkError = { code: 'ECONNRESET', message: 'Connection reset', config: {} };

      mockAxiosInstance.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');
      await vi.advanceTimersByTimeAsync(100);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 4xx errors (except 429 and 408)', async () => {
      const client = new HttpClient({ maxRetries: 3 });
      const error = { response: { status: 404 }, config: {}, message: 'Not found' };

      mockAxiosInstance.get.mockRejectedValue(error);

      await expect(client.get('/test')).rejects.toThrow();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should respect skipRetry option', async () => {
      const client = new HttpClient({ maxRetries: 3 });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get.mockRejectedValue(error);

      await expect(client.get('/test', { skipRetry: true })).rejects.toThrow();
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should throw HttpClientError after exhausting retries', async () => {
      const client = new HttpClient({ maxRetries: 2, retryDelayMs: 10 });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get.mockRejectedValue(error);

      const promise = client.get('/test');

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);

      await expect(promise).rejects.toThrow(HttpClientError);
      await expect(promise).rejects.toThrow(/failed after 2 retries/);
    });
  });

  describe('Rate Limiting (429)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should respect Retry-After header (seconds)', async () => {
      const client = new HttpClient({ maxRetries: 1 });
      const rateLimitError = {
        response: {
          status: 429,
          headers: { 'retry-after': '2' },
        },
        config: {},
        message: 'Rate limited',
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');

      // Should wait 2 seconds (2000ms)
      await vi.advanceTimersByTimeAsync(2000);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
    });

    it('should handle Retry-After as HTTP date', async () => {
      const client = new HttpClient({ maxRetries: 1 });
      const futureDate = new Date(Date.now() + 3000).toUTCString();
      const rateLimitError = {
        response: {
          status: 429,
          headers: { 'retry-after': futureDate },
        },
        config: {},
        message: 'Rate limited',
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');
      await vi.advanceTimersByTimeAsync(3000);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
    });

    it('should use default delay if Retry-After is missing', async () => {
      const client = new HttpClient({ maxRetries: 1, retryDelayMs: 500 });
      const rateLimitError = {
        response: { status: 429, headers: {} },
        config: {},
        message: 'Rate limited',
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');
      await vi.advanceTimersByTimeAsync(500);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
    });
  });

  describe('Circuit Breaker', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should open circuit breaker after threshold failures', async () => {
      const client = new HttpClient({
        maxRetries: 0,
        circuitBreakerOptions: { failureThreshold: 2, resetTimeoutMs: 5000 },
      });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get.mockRejectedValue(error);

      // First failure
      await expect(client.get('/test')).rejects.toThrow();

      // Second failure - should trip circuit breaker
      await expect(client.get('/test')).rejects.toThrow();

      // Third call should fail fast with circuit breaker error
      await expect(client.get('/test')).rejects.toThrow(HttpClientCircuitBreakerOpenError);

      // Should only have called axios twice (third blocked by circuit breaker)
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      const client = new HttpClient({
        maxRetries: 0,
        circuitBreakerOptions: { failureThreshold: 1, resetTimeoutMs: 1000 },
      });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      // Trip circuit breaker
      await expect(client.get('/test')).rejects.toThrow();

      // Should be OPEN
      await expect(client.get('/test')).rejects.toThrow(HttpClientCircuitBreakerOpenError);

      // Wait for reset timeout
      await vi.advanceTimersByTimeAsync(1000);

      // Should allow trial request (HALF_OPEN)
      const response = await client.get('/test');
      expect(response.data).toEqual({ success: true });
    });

    it('should allow skipCircuitBreaker option', async () => {
      const client = new HttpClient({
        maxRetries: 0,
        circuitBreakerOptions: { failureThreshold: 1 },
      });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get.mockRejectedValue(error);

      // Trip circuit breaker
      await expect(client.get('/test')).rejects.toThrow();

      // Regular request should fail fast
      await expect(client.get('/test')).rejects.toThrow(HttpClientCircuitBreakerOpenError);

      // Request with skipCircuitBreaker should bypass
      await expect(client.get('/test', { skipCircuitBreaker: true })).rejects.toThrow(
        HttpClientError
      );
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });

    it('should provide circuit breaker metrics', () => {
      const client = new HttpClient();
      const metrics = client.getCircuitBreakerMetrics();

      expect(metrics).toBeDefined();
      expect(metrics?.state).toBe('CLOSED');
      expect(metrics?.failures).toBe(0);
    });

    it('should allow manual circuit breaker reset', async () => {
      const client = new HttpClient({
        maxRetries: 0,
        circuitBreakerOptions: { failureThreshold: 1 },
      });
      const error = { response: { status: 500 }, config: {}, message: 'Server error' };

      mockAxiosInstance.get
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      // Trip circuit breaker
      await expect(client.get('/test')).rejects.toThrow();

      // Should be OPEN
      await expect(client.get('/test')).rejects.toThrow(HttpClientCircuitBreakerOpenError);

      // Manual reset
      client.resetCircuitBreaker();

      // Should work now
      const response = await client.get('/test');
      expect(response.data).toEqual({ success: true });
    });
  });

  describe('Timeout Handling', () => {
    it('should enforce request timeout', async () => {
      const client = new HttpClient({ timeout: 1000 });

      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1000 }));
    });

    it('should retry on timeout errors', async () => {
      vi.useFakeTimers();
      const client = new HttpClient({ maxRetries: 1, retryDelayMs: 100 });
      const timeoutError = { code: 'ECONNABORTED', message: 'Timeout', config: {} };

      mockAxiosInstance.get
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce({ data: { success: true }, status: 200, config: {} });

      const promise = client.get('/test');
      await vi.advanceTimersByTimeAsync(100);

      const response = await promise;
      expect(response.data).toEqual({ success: true });
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Concurrent Requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const client = new HttpClient();
      mockAxiosInstance.get.mockImplementation((url) =>
        Promise.resolve({ data: { url }, status: 200, config: {} })
      );

      const requests = [
        client.get('/endpoint1'),
        client.get('/endpoint2'),
        client.get('/endpoint3'),
      ];

      const responses = await Promise.all(requests);

      expect(responses).toHaveLength(3);
      expect(responses[0].data.url).toBe('/endpoint1');
      expect(responses[1].data.url).toBe('/endpoint2');
      expect(responses[2].data.url).toBe('/endpoint3');
    });
  });

  describe('Utility Methods', () => {
    it('should provide access to axios instance', () => {
      const client = new HttpClient();
      const instance = client.getAxiosInstance();

      expect(instance).toBe(mockAxiosInstance);
    });
  });
});
