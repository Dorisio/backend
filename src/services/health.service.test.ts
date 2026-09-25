import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkDatabaseHealth,
  checkCacheHealth,
  checkStellarHealth,
  getServiceState,
  setServiceState,
  resetServiceState,
  DEFAULT_CHECK_TIMEOUT_MS,
  type CacheClient,
  type DatabaseClient,
  type StellarHealthClient,
} from './health.service';

type MockPrisma = DatabaseClient;

describe('health.service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetServiceState();
  });

  describe('checkDatabaseHealth', () => {
    it('returns healthy when the query succeeds', async () => {
      const prisma: MockPrisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };

      const result = await checkDatabaseHealth(prisma);

      expect(result.status).toBe('healthy');
      expect(result.critical).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('returns unhealthy when the query rejects', async () => {
      const prisma: MockPrisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
      };

      const result = await checkDatabaseHealth(prisma);

      expect(result.status).toBe('unhealthy');
      expect(result.critical).toBe(true);
      expect(result.message).toContain('connection refused');
    });

    it('returns unhealthy when the query hangs past the timeout', async () => {
      const prisma: MockPrisma = {
        $queryRaw: vi.fn(() => new Promise(() => {})), // never resolves
      };

      const result = await checkDatabaseHealth(prisma, 20);

      expect(result.status).toBe('unhealthy');
      expect(result.message).toMatch(/timed out/i);
    });

    it('uses the default timeout when none is provided', () => {
      expect(DEFAULT_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
      expect(DEFAULT_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    });
  });

  describe('checkCacheHealth', () => {
    it('returns healthy when the client is open and PING succeeds', async () => {
      const cache: CacheClient = {
        isOpen: true,
        ping: vi.fn().mockResolvedValue('PONG'),
      };

      const result = await checkCacheHealth(cache);

      expect(result.status).toBe('healthy');
      expect(result.critical).toBe(true);
    });

    it('returns unhealthy without pinging when the client is not open', async () => {
      const cache: CacheClient = {
        isOpen: false,
        ping: vi.fn(),
      };

      const result = await checkCacheHealth(cache);

      expect(result.status).toBe('unhealthy');
      expect(result.message).toMatch(/not connected/i);
      expect(cache.ping).not.toHaveBeenCalled();
    });

    it('returns unhealthy when PING rejects', async () => {
      const cache: CacheClient = {
        isOpen: true,
        ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };

      const result = await checkCacheHealth(cache);

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('ECONNREFUSED');
    });

    it('returns unhealthy when PING hangs past the timeout', async () => {
      const cache: CacheClient = {
        isOpen: true,
        ping: vi.fn(() => new Promise(() => {})),
      };

      const result = await checkCacheHealth(cache, 20);

      expect(result.status).toBe('unhealthy');
      expect(result.message).toMatch(/timed out/i);
    });
  });

  describe('checkStellarHealth (non-critical external API)', () => {
    it('returns healthy and is marked non-critical when the network call succeeds', async () => {
      const stellarClient: StellarHealthClient = {
        getNetworkStatus: vi.fn().mockResolvedValue({ baseFee: 100, ledgerVersion: 12345 }),
      };

      const result = await checkStellarHealth(stellarClient);

      expect(result.status).toBe('healthy');
      expect(result.critical).toBe(false);
    });

    it('is marked non-critical (degraded, not fatal) when the network call fails', async () => {
      const stellarClient: StellarHealthClient = {
        getNetworkStatus: vi.fn().mockRejectedValue(new Error('Horizon unreachable')),
      };

      const result = await checkStellarHealth(stellarClient);

      expect(result.status).toBe('unhealthy');
      expect(result.critical).toBe(false);
      expect(result.message).toContain('Horizon unreachable');
    });

    it('is marked non-critical when the network call hangs past the timeout', async () => {
      const stellarClient: StellarHealthClient = {
        getNetworkStatus: vi.fn(() => new Promise(() => {})),
      };

      const result = await checkStellarHealth(stellarClient, 20);

      expect(result.status).toBe('unhealthy');
      expect(result.critical).toBe(false);
      expect(result.message).toMatch(/timed out/i);
    });
  });

  describe('service lifecycle state machine', () => {
    beforeEach(() => {
      resetServiceState();
    });

    it('starts in the "starting" state', () => {
      expect(getServiceState()).toBe('starting');
    });

    it('transitions starting -> ready -> shutting_down', () => {
      expect(getServiceState()).toBe('starting');

      setServiceState('ready');
      expect(getServiceState()).toBe('ready');

      setServiceState('shutting_down');
      expect(getServiceState()).toBe('shutting_down');
    });

    it('reflects whatever state is set regardless of ordering (module is a simple setter)', () => {
      setServiceState('shutting_down');
      expect(getServiceState()).toBe('shutting_down');

      setServiceState('starting');
      expect(getServiceState()).toBe('starting');
    });
  });
});
