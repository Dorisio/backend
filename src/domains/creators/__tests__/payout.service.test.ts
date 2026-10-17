import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { FakeTierPrisma, asPrisma } from './fake-tier-prisma';
import { PayoutService } from '../payout.service';
import { createCreatorTierRuntime } from '../tier.runtime';
import { AuditService } from '../../../services/audit.service';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../utils/errors';

// Mock Stellar client so payout transactions succeed in tests without network calls
vi.mock('../../../lib/stellar/client', () => ({
  getStellarClient: () => {
    const keypair = StellarSdk.Keypair.random();
    return {
      getServerKeypair: () => keypair,
      getServer: () => ({
        loadAccount: async (publicKey: string) => new StellarSdk.Account(publicKey, '100'),
      }),
      getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
      submitTransaction: async () => ({ id: 'tx_mock_stellar_hash_98765' }),
    };
  },
}));

vi.mock('../../../lib/cache/invalidation', () => ({
  invalidateCaches: vi.fn(),
  earningsCacheKey: vi.fn((id: string) => `earnings:${id}`),
  creatorCacheKeys: vi.fn((id: string) => [`creator:${id}`]),
}));

describe('PayoutService - Creator Tier Constraints', () => {
  let fake: FakeTierPrisma;
  let auditService: AuditService;
  let tierRuntime: ReturnType<typeof createCreatorTierRuntime>;
  let payoutService: PayoutService;

  beforeEach(() => {
    fake = new FakeTierPrisma();
    auditService = new AuditService(fake.auditLog as any);
    tierRuntime = createCreatorTierRuntime(asPrisma(fake), {
      autoFlushUsage: false,
      autoPrune: false,
    });
    payoutService = new PayoutService(asPrisma(fake), {
      tierRuntime,
      auditService,
    });
  });

  describe('evaluateCreatorTierEligibility', () => {
    it('applies standard free tier fee (10%) to free tier creator', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 0,
        followerCount: 0,
      });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 100,
      });

      expect(evaluation.claimedTier).toBe('free');
      expect(evaluation.appliedTier).toBe('free');
      expect(evaluation.isEligible).toBe(true);
      expect(evaluation.feeRate).toBe(0.10);
      expect(evaluation.feeAmount).toBe(10);
      expect(evaluation.netAmount).toBe(90);
    });

    it('applies discounted pro tier fee (5%) when earnings and followers meet thresholds', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 1500,
        followerCount: 150,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 200,
      });

      expect(evaluation.claimedTier).toBe('pro');
      expect(evaluation.appliedTier).toBe('pro');
      expect(evaluation.isEligible).toBe(true);
      expect(evaluation.feeRate).toBe(0.05);
      expect(evaluation.feeAmount).toBe(10);
      expect(evaluation.netAmount).toBe(190);
    });

    it('falls back to standard lowest tier fee (10%) when pro creator has insufficient earnings', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 500, // < 1000 threshold
        followerCount: 200, // meets followers
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 100,
      });

      expect(evaluation.claimedTier).toBe('pro');
      expect(evaluation.appliedTier).toBe('free');
      expect(evaluation.isEligible).toBe(false);
      expect(evaluation.feeRate).toBe(0.10); // Standard lowest tier fee rate, NOT 0.05
      expect(evaluation.feeAmount).toBe(10);
      expect(evaluation.netAmount).toBe(90);
    });

    it('falls back to standard lowest tier fee (10%) when pro creator has insufficient followers', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 2000, // meets earnings
        followerCount: 50, // < 100 threshold
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 100,
      });

      expect(evaluation.claimedTier).toBe('pro');
      expect(evaluation.appliedTier).toBe('free');
      expect(evaluation.isEligible).toBe(false);
      expect(evaluation.feeRate).toBe(0.10);
      expect(evaluation.netAmount).toBe(90);
    });

    it('applies premium enterprise tier fee (2%) when earnings >= 10000 and followers >= 1000', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 15000,
        followerCount: 1200,
      });
      fake.seedSubscription(creator.id, { tier: 'enterprise', status: 'active' });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 1000,
      });

      expect(evaluation.claimedTier).toBe('enterprise');
      expect(evaluation.appliedTier).toBe('enterprise');
      expect(evaluation.isEligible).toBe(true);
      expect(evaluation.feeRate).toBe(0.02);
      expect(evaluation.feeAmount).toBe(20);
      expect(evaluation.netAmount).toBe(980);
    });

    it('falls back to free tier fee (10%) when enterprise creator does not meet thresholds', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 8000, // < 10000
        followerCount: 500,  // < 1000
      });
      fake.seedSubscription(creator.id, { tier: 'enterprise', status: 'active' });

      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 1000,
      });

      expect(evaluation.claimedTier).toBe('enterprise');
      expect(evaluation.appliedTier).toBe('free');
      expect(evaluation.isEligible).toBe(false);
      expect(evaluation.feeRate).toBe(0.10);
      expect(evaluation.feeAmount).toBe(100);
      expect(evaluation.netAmount).toBe(900);
    });

    it('throws 403 Forbidden when strictTierEnforcement is enabled and creator is ineligible', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 200,
        followerCount: 10,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      await expect(
        payoutService.evaluateCreatorTierEligibility(creator.id, {
          requestedAmount: 100,
          strictTierEnforcement: true,
        })
      ).rejects.toThrow(ForbiddenError);

      // Verify rejection is logged in audit trail
      const logs = await auditService.query({ action: 'payout.tier_evaluation' });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].changes.isEligible.new).toBe(false);
      expect(logs[0].changes.appliedTier.new).toBe('rejected');
    });

    it('respects followerCount passed in options override', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 1500,
        followerCount: 10, // model says 10
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });

      // Passing followerCount: 150 in options makes them eligible
      const evaluation = await payoutService.evaluateCreatorTierEligibility(creator.id, {
        requestedAmount: 100,
        followerCount: 150,
      });

      expect(evaluation.isEligible).toBe(true);
      expect(evaluation.appliedTier).toBe('pro');
      expect(evaluation.feeRate).toBe(0.05);
    });
  });

  describe('calculatePayoutFee preview', () => {
    it('returns fee calculation without mutating records', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 12000,
        followerCount: 1500,
      });
      fake.seedSubscription(creator.id, { tier: 'enterprise', status: 'active' });

      const preview = await payoutService.calculatePayoutFee(creator.id, 500);

      expect(preview.claimedTier).toBe('enterprise');
      expect(preview.appliedTier).toBe('enterprise');
      expect(preview.feeRate).toBe(0.02);
      expect(preview.feeAmount).toBe(10);
      expect(preview.netAmount).toBe(490);
      expect(fake.payouts).toHaveLength(0);
    });
  });

  describe('processPayout', () => {
    it('enforces tier fee discount for eligible pro creator and logs decision in audit trail', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 2000,
        followerCount: 200,
        pendingBalance: 500,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      const payout = await payoutService.processPayout(creator.id, {
        amount: 100,
      });

      // Eligible pro creator gets 5% fee rate
      expect(payout.tier).toBe('pro');
      expect(payout.claimedTier).toBe('pro');
      expect(payout.tierEligible).toBe(true);
      expect(payout.feeRate).toBe(0.05);
      expect(payout.feeAmount).toBe(5);
      expect(payout.netAmount).toBe(95);
      expect(payout.grossAmount).toBe(100);
      expect(payout.payoutAmount).toBe(100);
      expect(payout.status).toBe('completed');
      expect(payout.pendingBalance).toBe(400); // 500 - 100 gross amount

      // Verify audit trail logged before/during payout
      const auditLogs = await auditService.query({ action: 'payout.tier_evaluation' });
      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];
      expect(log.userId).toBe(creator.userId);
      expect(log.resource).toBe('payout');
      expect(log.resourceId).toBe(payout.id);
      expect(log.changes.claimedTier.new).toBe('pro');
      expect(log.changes.appliedTier.new).toBe('pro');
      expect(log.changes.isEligible.new).toBe(true);
      expect(log.changes.feeRate.new).toBe(0.05);
      expect(log.changes.feeAmount.new).toBe(5);
      expect(log.changes.grossAmount.new).toBe(100);
      expect(log.changes.netAmount.new).toBe(95);
    });

    it('charges standard lowest tier fee (10%) to ineligible pro creator and audits the decision', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 300, // Ineligible for pro
        followerCount: 10,
        pendingBalance: 300,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      const payout = await payoutService.processPayout(creator.id, {
        amount: 100,
      });

      // Ineligible creator gets standard free tier fee rate (10%), NOT pro 5%
      expect(payout.claimedTier).toBe('pro');
      expect(payout.tier).toBe('free');
      expect(payout.tierEligible).toBe(false);
      expect(payout.feeRate).toBe(0.10);
      expect(payout.feeAmount).toBe(10);
      expect(payout.netAmount).toBe(90);
      expect(payout.status).toBe('completed');
      expect(payout.pendingBalance).toBe(200);

      // Verify audit trail recorded tier decision
      const auditLogs = await auditService.query({ action: 'payout.tier_evaluation' });
      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];
      expect(log.changes.claimedTier.new).toBe('pro');
      expect(log.changes.appliedTier.new).toBe('free');
      expect(log.changes.isEligible.new).toBe(false);
      expect(log.changes.feeRate.new).toBe(0.10);
    });

    it('rejects payout with 403 Forbidden when strictTierEnforcement is requested for ineligible creator', async () => {
      const creator = fake.seedCreator({
        totalEarnings: 200,
        followerCount: 15,
        pendingBalance: 400,
      });
      fake.seedSubscription(creator.id, { tier: 'pro', status: 'active' });
      fake.seedWallet(creator.userId, { verified: true });

      await expect(
        payoutService.processPayout(creator.id, {
          amount: 100,
          strictTierEnforcement: true,
        })
      ).rejects.toThrow(ForbiddenError);

      // Pending balance is NOT decremented
      expect(creator.pendingBalance).toBe(400);
      expect(fake.payouts).toHaveLength(0);
    });

    it('rejects payout if amount exceeds pending balance', async () => {
      const creator = fake.seedCreator({
        pendingBalance: 80,
      });
      fake.seedWallet(creator.userId, { verified: true });

      await expect(
        payoutService.processPayout(creator.id, {
          amount: 150,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects payout if creator has no verified wallet', async () => {
      const creator = fake.seedCreator({
        pendingBalance: 500,
      });

      await expect(
        payoutService.processPayout(creator.id, {
          amount: 100,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects payout if creator does not exist', async () => {
      await expect(
        payoutService.processPayout('non_existent_creator', {
          amount: 100,
        })
      ).rejects.toThrow(NotFoundError);
    });
  });
});
