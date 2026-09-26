import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { registerAdminRoutes } from '../../domains/admin/admin.routes';

// ── auth middleware mock ──────────────────────────────────────────────────────
// Intercept authMiddleware so tests control request.user without real JWTs.
// requireAdmin calls requireRole which calls authMiddleware internally.
const authMiddlewareMock = vi.fn();
vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

// ── admin service mock ────────────────────────────────────────────────────────
vi.mock('../../domains/admin/admin.service', () => ({
  AdminService: vi.fn().mockImplementation(() => ({
    flagWallet: vi.fn().mockResolvedValue({ id: 'flag-1' }),
    unflagWallet: vi.fn().mockResolvedValue(undefined),
    freezeAccount: vi.fn().mockResolvedValue({ id: 'freeze-1' }),
    unfreezeAccount: vi.fn().mockResolvedValue(undefined),
    getModerationQueue: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  })),
}));

// ── cache mock ────────────────────────────────────────────────────────────────
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
}));

// ── helpers ───────────────────────────────────────────────────────────────────

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

function setUnauthenticated() {
  authMiddlewareMock.mockRejectedValue(
    Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' }),
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('admin routes — requireAdmin RBAC enforcement (#35)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  describe('POST /api/v1/admin/wallets/:address/flag', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects regular (fan) users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects creator users with 403', async () => {
      setUser('creator');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/wallets/GABC/flag',
        payload: { reason: 'spam', severity: 'low' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/admin/creators/:creatorId/freeze', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/creators/creator-1/freeze',
        payload: { reason: 'violation' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/creators/creator-1/freeze',
        payload: { reason: 'violation' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/admin/moderation', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation' });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/admin/cache/stats', () => {
    it('allows admin users', async () => {
      setUser('admin');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/cache/stats' });
      expect(res.statusCode).toBe(200);
    });

    it('rejects fan users with 403', async () => {
      setUser('fan');
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/cache/stats' });
      expect(res.statusCode).toBe(403);
    });
  });
});
