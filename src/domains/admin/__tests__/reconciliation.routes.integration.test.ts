import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerAdminRoutes } from '../admin.routes';

const authMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

const reconciliationServiceMocks = vi.hoisted(() => ({
  getReconciliationReport: vi.fn(),
  toCsv: vi.fn(),
}));

vi.mock('../reconciliation.service', () => ({
  ReconciliationService: vi.fn().mockImplementation(() => reconciliationServiceMocks),
}));

vi.mock('../../lib/cache/index', () => ({
  default: { clear: vi.fn(), del: vi.fn() },
  getStats: vi.fn().mockReturnValue({}),
  getHitRate: vi.fn().mockReturnValue(0),
  resetStats: vi.fn(),
}));

vi.mock('../../lib/cache/cache-warming', () => ({
  CacheWarmer: vi.fn().mockImplementation(() => ({
    warmAll: vi.fn().mockResolvedValue(undefined),
    warmTopCreators: vi.fn().mockResolvedValue(undefined),
    warmTrendingData: vi.fn().mockResolvedValue(undefined),
    warmAnalyticsData: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../lib/requestContext', () => ({
  setRequestContextUserId: vi.fn(),
  getRequestContext: vi.fn().mockReturnValue(undefined),
  runWithContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAdminRoutes(app, {} as unknown as PrismaClient);
  return app;
}

function setUser(role: string) {
  authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
    request.user = { userId: 'u-1', email: 'test@example.com', role };
  });
}

describe('GET /api/admin/payments/reconciliation (reconciliation report)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  describe('RBAC', () => {
    it('allows admin users', async () => {
      setUser('admin');
      reconciliationServiceMocks.getReconciliationReport.mockResolvedValue({
        period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z' },
        statusBreakdown: { successful: 5, failed: 1, pending: 2, cancelled: 0, disputed: 0, total: 8 },
        revenueByAsset: [],
        revenueByTier: [],
        totalRevenue: 100,
        totalFees: 1,
        stellarTransactionCount: 5,
        totalPayments: 8,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation?from=2026-10-01&to=2026-10-17',
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(reconciliationServiceMocks.getReconciliationReport).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) })
      );
    });

    it('allows versioned path /api/v1/admin/payments/reconciliation', async () => {
      setUser('admin');
      reconciliationServiceMocks.getReconciliationReport.mockResolvedValue({
        period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z' },
        statusBreakdown: { successful: 0, failed: 0, pending: 0, cancelled: 0, disputed: 0, total: 0 },
        revenueByAsset: [],
        revenueByTier: [],
        totalRevenue: 0,
        totalFees: 0,
        stellarTransactionCount: 0,
        totalPayments: 0,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/payments/reconciliation',
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation',
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects creator users with 403', async () => {
      setUser('creator');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation',
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('response shape', () => {
    beforeEach(() => setUser('admin'));

    it('returns status breakdown by date range', async () => {
      reconciliationServiceMocks.getReconciliationReport.mockResolvedValue({
        period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
        statusBreakdown: { successful: 4, failed: 1, pending: 2, cancelled: 1, disputed: 0, total: 8 },
        revenueByAsset: [
          { assetCode: 'USDC', assetIssuer: 'GB...', count: 6, revenue: 120, fees: 1.2 },
        ],
        revenueByTier: [
          { tier: 'pro', count: 5, revenue: 80, fees: 0.8 },
          { tier: 'free', count: 3, revenue: 40, fees: 0.4 },
        ],
        totalRevenue: 120,
        totalFees: 1.2,
        stellarTransactionCount: 4,
        totalPayments: 8,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation?from=2026-10-01&to=2026-10-08',
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.statusBreakdown).toEqual({
        successful: 4,
        failed: 1,
        pending: 2,
        cancelled: 1,
        disputed: 0,
        total: 8,
      });
      expect(json.data.revenueByAsset).toHaveLength(1);
      expect(json.data.revenueByAsset[0]).toMatchObject({
        assetCode: 'USDC',
        count: 6,
        revenue: 120,
      });
      expect(json.data.revenueByTier).toHaveLength(2);
      expect(json.data.stellarTransactionCount).toBe(4);
      expect(json.data.totalPayments).toBe(8);
    });

    it('passes the parsed date range to the service', async () => {
      reconciliationServiceMocks.getReconciliationReport.mockResolvedValue({
        period: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
        statusBreakdown: { successful: 0, failed: 0, pending: 0, cancelled: 0, disputed: 0, total: 0 },
        revenueByAsset: [],
        revenueByTier: [],
        totalRevenue: 0,
        totalFees: 0,
        stellarTransactionCount: 0,
        totalPayments: 0,
      });
      await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation?from=2026-09-01&to=2026-09-30',
      });
      const [, filters] = reconciliationServiceMocks.getReconciliationReport.mock.calls[0];
      expect(filters.from instanceof Date).toBe(true);
      expect(filters.to instanceof Date).toBe(true);
      expect(filters.from.getFullYear()).toBe(2026);
      expect(filters.from.getMonth()).toBe(8); // September
      expect(filters.to.getMonth()).toBe(8);
    });
  });

  describe('CSV export', () => {
    beforeEach(() => setUser('admin'));

    it('returns text/csv when format=csv', async () => {
      reconciliationServiceMocks.getReconciliationReport.mockResolvedValue({
        period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
        statusBreakdown: { successful: 2, failed: 0, pending: 0, cancelled: 0, disputed: 0, total: 2 },
        revenueByAsset: [],
        revenueByTier: [],
        totalRevenue: 50,
        totalFees: 0.5,
        stellarTransactionCount: 2,
        totalPayments: 2,
      });
      reconciliationServiceMocks.toCsv.mockReturnValue('Reconciliation Report\n');
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation?from=2026-10-01&to=2026-10-08&format=csv',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment; filename="reconciliation-report.csv"');
      expect(reconciliationServiceMocks.toCsv).toHaveBeenCalled();
      expect(res.payload).toBe('Reconciliation Report\n');
    });
  });

  describe('validation', () => {
    beforeEach(() => setUser('admin'));

    it('rejects invalid period with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payments/reconciliation?from=2026-10-17&to=2026-10-01',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
