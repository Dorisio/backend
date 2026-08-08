import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PaymentService } from '../../domains/payments/payment.service';
import { UserService } from '../../domains/users/user.service';
import { PayoutService } from '../../domains/creators/payout.service';

let prisma: PrismaClient;
let paymentService: PaymentService;
let userService: UserService;
let payoutService: PayoutService;

// Test data
let testUserId: string;
let testCreatorId: string;
let testCreatorUserId: string;

describe('Tip Flow Integration Tests', () => {
  beforeAll(async () => {
    prisma = new PrismaClient();
    paymentService = new PaymentService(prisma);
    userService = new UserService(prisma);
    payoutService = new PayoutService(prisma);
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.tip.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.creator.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Create test users
    const fanUser = await prisma.user.create({
      data: {
        email: `fan-${Date.now()}@test.com`,
        password: 'hashed-password',
        name: 'Test Fan',
        role: 'fan',
      },
    });
    testUserId = fanUser.id;

    const creatorUser = await prisma.user.create({
      data: {
        email: `creator-${Date.now()}@test.com`,
        password: 'hashed-password',
        name: 'Test Creator',
        role: 'creator',
      },
    });
    testCreatorUserId = creatorUser.id;

    // Create creator profile
    const creator = await prisma.creator.create({
      data: {
        userId: testCreatorUserId,
        username: `creator-${Date.now()}`,
        displayName: 'Test Creator',
        isPublic: true,
      },
    });
    testCreatorId = creator.id;

    // Link verified wallet to fan
    await prisma.wallet.create({
      data: {
        userId: testUserId,
        publicKey: `GBBD47AB2EB00E041B61C1B7AD184E687E24658D52EDFFDD118F5E6221D60E${Math.random().toString().slice(2, 4)}`,
        verified: true,
      },
    });
  });

  describe('Complete tip flow', () => {
    it('should create tip with valid data', async () => {
      const tip = await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 100,
        message: 'Great content!',
      });

      expect(tip.id).toBeDefined();
      expect(tip.amount).toBe(100);
      expect(tip.status).toBe('pending');
      expect(tip.creatorId).toBe(testCreatorId);
      expect(tip.fromUserId).toBe(testUserId);
    });

    it('should retrieve created tip', async () => {
      const created = await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 50,
      });

      const retrieved = await paymentService.getTip(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.amount).toBe(50);
    });

    it('should list tips for creator', async () => {
      // Create multiple tips
      await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 25,
      });

      await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 75,
      });

      const result = await paymentService.listTips(testCreatorId, 1, 10);

      expect(result.tips.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('should update tip status to completed', async () => {
      const tip = await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 100,
      });

      const updated = await paymentService.updateTipStatus(tip.id, {
        status: 'completed',
      });

      expect(updated.status).toBe('completed');

      // Verify creator earnings updated
      const creator = await prisma.creator.findUnique({
        where: { id: testCreatorId },
      });

      expect(creator?.totalEarnings).toBe(100);
      expect(creator?.pendingBalance).toBe(100);
    });

    it('should get user transaction history', async () => {
      // Create some tips
      await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 30,
      });

      await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 70,
      });

      const history = await userService.getUserTransactionHistory(testUserId, 1, 10);

      expect(history.transactions.length).toBeGreaterThanOrEqual(2);
      expect(history.page).toBe(1);
    });

    it('should get creator earnings breakdown', async () => {
      // Create and complete a tip
      const tip = await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 100,
      });

      await paymentService.updateTipStatus(tip.id, { status: 'completed' });

      const earnings = await payoutService.getEarningsBreakdown(testCreatorId);

      expect(earnings.totalEarnings).toBe(100);
      expect(earnings.pendingBalance).toBe(100);
      expect(earnings.paidOut).toBe(0);
    });

    it('should process payout', async () => {
      // Create and complete a tip first
      const tip = await paymentService.createTip(testUserId, {
        creatorId: testCreatorId,
        amount: 50,
      });

      await paymentService.updateTipStatus(tip.id, { status: 'completed' });

      // Process payout
      const payout = await payoutService.processPayout(testCreatorId, {
        amount: 50,
      });

      expect(payout.payoutAmount).toBe(50);
      expect(payout.pendingBalance).toBe(0);
    });

    it('should get creator completeness checklist', async () => {
      const checklist = await payoutService.getCreatorCompletenessChecklist(testCreatorId);

      expect(checklist.creatorId).toBe(testCreatorId);
      expect(checklist.completeness).toBeDefined();
      expect(checklist.checklist).toBeDefined();
      expect(Array.isArray(checklist.checklist)).toBe(true);
      expect(checklist.recommendations).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should fail to create tip for non-existent creator', async () => {
      expect(async () => {
        await paymentService.createTip(testUserId, {
          creatorId: 'non-existent-creator',
          amount: 100,
        });
      }).rejects.toThrow();
    });

    it('should fail to create tip without verified wallet', async () => {
      // Create user without wallet
      const userNoWallet = await prisma.user.create({
        data: {
          email: `no-wallet-${Date.now()}@test.com`,
          password: 'hashed-password',
          name: 'No Wallet User',
        },
      });

      expect(async () => {
        await paymentService.createTip(userNoWallet.id, {
          creatorId: testCreatorId,
          amount: 100,
        });
      }).rejects.toThrow();
    });

    it('should fail to create tip with invalid amount', async () => {
      expect(async () => {
        await paymentService.createTip(testUserId, {
          creatorId: testCreatorId,
          amount: -10,
        });
      }).rejects.toThrow();
    });

    it('should fail payout exceeding pending balance', async () => {
      expect(async () => {
        await payoutService.processPayout(testCreatorId, {
          amount: 10000,
        });
      }).rejects.toThrow();
    });
  });
});
