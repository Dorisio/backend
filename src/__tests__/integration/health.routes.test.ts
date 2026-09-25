import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerHealthRoutes } from '../../routes/health.routes';
import { resetServiceState, setServiceState } from '../../services/health.service';
import type { CacheClient, DatabaseClient } from '../../services/health.service';

// Mock the Stellar client so readiness/liveness tests never make a real
// network call to Horizon/RPC - per the issue notes, there's no cheap way
// to ping Stellar without a live network call, so we mock it here.
const getNetworkStatusMock = vi.fn();
vi.mock('../../lib/stellar/client', () => ({
  getStellarClient: () => ({
    getNetworkStatus: getNetworkStatusMock,
  }),
}));

// Only `$queryRaw` is exercised by the health checks; the full PrismaClient
// type is cast to at the call boundary so route registration keeps its
// real `PrismaClient` signature while tests only need to fake this slice.
type MockPrisma = DatabaseClient;

function buildApp(prisma: MockPrisma, cache: CacheClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, prisma as unknown as PrismaClient, cache);
  return app;
}

function healthyPrisma(): MockPrisma {
  return { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
}

function unhealthyPrisma(): MockPrisma {
  return { $queryRaw: vi.fn().mockRejectedValue(new Error('db down')) };
}

function healthyCache(): CacheClient {
  return { isOpen: true, ping: vi.fn().mockResolvedValue('PONG') };
}

function unhealthyCache(): CacheClient {
  return { isOpen: false, ping: vi.fn() };
}

describe('health routes', () => {
  beforeEach(() => {
    resetServiceState();
    getNetworkStatusMock.mockReset();
    getNetworkStatusMock.mockResolvedValue({ baseFee: 100, ledgerVersion: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health (liveness)', () => {
    it('returns 200 when the database is reachable', async () => {
      const app = buildApp(healthyPrisma(), healthyCache());

      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.checks.database.status).toBe('healthy');
    });

    it('does not return 503 even during the "starting" service state', async () => {
      // Liveness must not depend on readiness state - a process can be
      // alive and healthy while still warming up.
      const app = buildApp(healthyPrisma(), healthyCache());

      const res = await app.inject({ method: 'GET', url: '/health' });

      expect(res.statusCode).toBe(200);
    });

    it('responds quickly (probe latency stays low)', async () => {
      const app = buildApp(healthyPrisma(), healthyCache());

      const start = Date.now();
      const res = await app.inject({ method: 'GET', url: '/health' });
      const elapsed = Date.now() - start;

      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('GET /readiness', () => {
    it('returns 200 with structured checks when all critical deps are healthy', async () => {
      const app = buildApp(healthyPrisma(), healthyCache());
      setServiceState('ready');

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.checks.database.status).toBe('healthy');
      expect(body.checks.cache.status).toBe('healthy');
      expect(body.checks.stellar).toBeDefined();
    });

    it('returns 503 when the database is down', async () => {
      const app = buildApp(unhealthyPrisma(), healthyCache());
      setServiceState('ready');

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.status).toBe('unhealthy');
    });

    it('returns 503 when the cache is down', async () => {
      const app = buildApp(healthyPrisma(), unhealthyCache());
      setServiceState('ready');

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('unavailable');
      expect(body.checks.cache.status).toBe('unhealthy');
    });

    it('returns 200 (degraded, not unavailable) when only the non-critical Stellar check fails', async () => {
      getNetworkStatusMock.mockRejectedValue(new Error('Horizon unreachable'));
      const app = buildApp(healthyPrisma(), healthyCache());
      setServiceState('ready');

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('degraded');
      expect(body.checks.stellar.status).toBe('unhealthy');
      expect(body.checks.stellar.critical).toBe(false);
    });

    it('returns 503 during the "starting" state, before deps are checked', async () => {
      const prisma = healthyPrisma();
      const cache = healthyCache();
      const app = buildApp(prisma, cache);
      // service state defaults to "starting" via resetServiceState() in beforeEach

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('unavailable');
      expect(body.checks.service.message).toMatch(/starting/i);
      // Dependency checks should be skipped entirely while not ready.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(cache.ping).not.toHaveBeenCalled();
    });

    it('returns 503 during the "shutting_down" state, even if all deps are healthy', async () => {
      const app = buildApp(healthyPrisma(), healthyCache());
      setServiceState('ready');
      setServiceState('shutting_down');

      const res = await app.inject({ method: 'GET', url: '/readiness' });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('unavailable');
      expect(body.checks.service.message).toMatch(/shutting_down/i);
    });

    it('responds quickly when ready (probe latency stays low)', async () => {
      const app = buildApp(healthyPrisma(), healthyCache());
      setServiceState('ready');

      const start = Date.now();
      const res = await app.inject({ method: 'GET', url: '/readiness' });
      const elapsed = Date.now() - start;

      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
