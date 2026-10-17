import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as StellarSdk from '@stellar/stellar-sdk';
import { FakeTierPrisma, asPrisma } from './fake-tier-prisma';
import { createCreatorTierRuntime } from '../tier.runtime';
import { registerCreatorPayoutRoutes } from '../payout.routes';
import { AuditService } from '../../../services/audit.service';

const { authMiddlewareMock } = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
}));

vi.mock('../../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
}));

vi.mock('../../../lib/stellar/client', () => ({
  getStellarClient: () => {
    const keypair = StellarSdk.Keypair.random();
    return {
      getServerKeypair: () => keypair,
      getServer: () => ({
        loadAccount: async (publicKey: string) => new StellarSdk.Account(publicKey, '100'),
      }),
      getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
      submitTransaction: async () => ({ id: 'tx_mock_hash_route_123' }),
    };
  },
}));

vi.mock('../../../lib/cache/invalidation', () => ({
  invalidateCaches: vi.fn(),
  earningsCacheKey: vi.fn((id: string) => `earnings:${id}`),
  creatorCacheKeys: vi.fn((id: string) => [`creator:${id}`]),
}));

function setUser(userId = 'user_1') {
  authMiddlewareMock.mockImplementation(async (request: { user?: unknown }) => {
    request.user = { userId, email: 'creator@example.com', role: 'user' };
  });
}

interface Harness {
  app: FastifyInstance;
  fake: FakeTierPrisma;
  auditService: AuditService;
  close: () => Promise<void>;
}

function buildHarness(): Harness {
  const fake = new FakeTierPrisma();
  const app = Fastify({ logger: false });
  const auditService = new AuditService(fake.auditLog as any);
  const runtime = createCreatorTierRuntime(asPrisma(fake), {
    autoFlushUsage: false,
    autoPrune: false,
  });

  registerCreatorPayoutRoutes(app, asPrisma(fake), {
    tierRuntime: runtime,
    auditService,
  });

  return { app, fake, auditService, close: () => runtime.close() };
}

describe('Creator Payout Routes - Tier Enforcement', () => {
  beforeEach(() => {
    authMiddlewareMock.mockReset();
    setUser('user_1');
  });

  describe('POST /api/v1/creators/payout', () => {
    it('applies discounted tier fee for eligible pro creator', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        totalEarnings: 2000,
        followerCount: 150,
        pendingBalance: 500,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout',
        payload: {
          amount: 100,
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.tier).toBe('pro');
      expect(json.data.claimedTier).toBe('pro');
      expect(json.data.tierEligible).toBe(true);
      expect(json.data.feeRate).toBe(0.05);
      expect(json.data.feeAmount).toBe(5);
      expect(json.data.netAmount).toBe(95);
      expect(json.data.status).toBe('completed');
    });

    it('falls back to standard lowest tier fee (10%) for ineligible pro creator', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        totalEarnings: 200, // < 1000
        followerCount: 20,  // < 100
        pendingBalance: 500,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout',
        payload: {
          amount: 100,
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.claimedTier).toBe('pro');
      expect(json.data.tier).toBe('free'); // standard lowest tier
      expect(json.data.tierEligible).toBe(false);
      expect(json.data.feeRate).toBe(0.10);
      expect(json.data.feeAmount).toBe(10);
      expect(json.data.netAmount).toBe(90);
    });

    it('returns 403 Forbidden when strictTierEnforcement is enabled and creator is ineligible', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        totalEarnings: 200,
        followerCount: 20,
        pendingBalance: 500,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout',
        payload: {
          amount: 100,
          strictTierEnforcement: true,
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
      expect(json.error.message).toContain('not eligible for pro tier payout fee rate');
    });

    it('returns 400 when amount exceeds pending balance', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        pendingBalance: 80,
      });
      fake.seedWallet(creator.userId, { verified: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout',
        payload: {
          amount: 200,
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/creators/payout/calculate', () => {
    it('previews fee calculations and tier eligibility', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        totalEarnings: 15000,
        followerCount: 1500,
      });
      fake.seedSubscription(creator.id, { tier: 'enterprise', status: 'active' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout/calculate',
        payload: {
          amount: 500,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.claimedTier).toBe('enterprise');
      expect(json.data.appliedTier).toBe('enterprise');
      expect(json.data.isEligible).toBe(true);
      expect(json.data.feeRate).toBe(0.02);
      expect(json.data.feeAmount).toBe(10);
      expect(json.data.netAmount).toBe(490);
    });

    it('returns 403 on calculate preview when strictTierEnforcement is requested and ineligible', async () => {
      const { app, fake } = buildHarness();
      const creator = fake.seedCreator({
        userId: 'user_1',
        totalEarnings: 50,
        followerCount: 2,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/creators/payout/calculate',
        payload: {
          amount: 100,
          strictTierEnforcement: true,
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });
  });
});
