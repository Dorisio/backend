import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentService } from './payment.service';
import { ValidationError, NotFoundError } from '../../utils/errors';

// Mock Prisma
const mockPrisma = {
  creator: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  wallet: {
    findFirst: vi.fn(),
  },
  tip: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn((callback: (tx: any) => Promise<unknown>) => callback(mockPrisma)),
};

describe('PaymentService', () => {
  let paymentService: PaymentService;

  beforeEach(() => {
    paymentService = new PaymentService(mockPrisma as any);
    vi.clearAllMocks();
  });

  describe('createTip', () => {
    it('should create a tip successfully', async () => {
      const userId = 'user-123';
      const creatorId = 'creator-123';

      mockPrisma.user.findUnique.mockResolvedValue({
        id: userId,
      });

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
        isPublic: true,
        verified: true,
      });

      mockPrisma.wallet.findFirst.mockResolvedValue({
        id: 'wallet-123',
        verified: true,
      });

      mockPrisma.tip.create.mockResolvedValue({
        id: 'tip-123',
        fromUserId: userId,
        creatorId,
        amount: 100,
        message: 'Great content!',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await paymentService.createTip(userId, {
        creatorId,
        amount: 100,
        message: 'Great content!',
      });

      expect(result.id).toBe('tip-123');
      expect(result.amount).toBe(100);
      expect(result.status).toBe('pending');
      expect(mockPrisma.tip.create).toHaveBeenCalled();
    });

    it('should throw ValidationError for invalid amount', async () => {
      const userId = 'user-123';
      const creatorId = 'creator-123';

      await expect(
        paymentService.createTip(userId, {
          creatorId,
          amount: -10,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw NotFoundError if creator does not exist', async () => {
      const userId = 'user-123';
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.createTip(userId, {
          creatorId,
          amount: 100,
        })
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError if creator is not public', async () => {
      const userId = 'user-123';
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
        isPublic: false,
      });

      await expect(
        paymentService.createTip(userId, {
          creatorId,
          amount: 100,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if wallet is not verified', async () => {
      const userId = 'user-123';
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
        isPublic: true,
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      await expect(
        paymentService.createTip(userId, {
          creatorId,
          amount: 100,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getTip', () => {
    it('should retrieve a tip', async () => {
      const tipId = 'tip-123';

      mockPrisma.tip.findUnique.mockResolvedValue({
        id: tipId,
        fromUserId: 'user-123',
        creatorId: 'creator-123',
        amount: 100,
        message: 'Great!',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await paymentService.getTip(tipId);

      expect(result.id).toBe(tipId);
      expect(result.amount).toBe(100);
      expect(mockPrisma.tip.findUnique).toHaveBeenCalledWith({
        where: { id: tipId },
        select: {
          id: true,
          fromUserId: true,
          creatorId: true,
          amount: true,
          message: true,
          status: true,
          transactionHash: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    it('should throw NotFoundError if tip does not exist', async () => {
      mockPrisma.tip.findUnique.mockResolvedValue(null);

      await expect(paymentService.getTip('non-existent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('listTips & listTipsCursor', () => {
    it('should list tips with offset pagination and metadata', async () => {
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
      });

      mockPrisma.tip.findMany.mockResolvedValue([
        {
          id: 'tip-1',
          creatorId,
          fromUserId: 'user-1',
          amount: 100,
          status: 'completed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'tip-2',
          creatorId,
          fromUserId: 'user-2',
          amount: 50,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockPrisma.tip.count.mockResolvedValue(25);

      const result = await paymentService.listTips(creatorId, 1, 20, { status: 'completed' });

      expect(result.tips).toHaveLength(2);
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(2);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
      expect(mockPrisma.tip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { creatorId, status: 'completed' },
          skip: 0,
          take: 20,
        })
      );
    });

    it('should list tips with cursor pagination', async () => {
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
      });

      mockPrisma.tip.findMany.mockResolvedValue([
        {
          id: 'tip-1',
          creatorId,
          fromUserId: 'user-1',
          amount: 100,
          status: 'completed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await paymentService.listTipsCursor(creatorId, { limit: 10 });
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.pageInfo).toBeDefined();
    });

    it('should get user tip history with offset pagination', async () => {
      const userId = 'user-123';

      mockPrisma.tip.findMany.mockResolvedValue([
        {
          id: 'tip-1',
          creatorId: 'c-1',
          fromUserId: userId,
          amount: 50,
          status: 'completed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockPrisma.tip.count.mockResolvedValue(1);

      const result = await paymentService.getUserTipHistory(userId, 1, 20);

      expect(result.tips).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should get user tip history with cursor pagination', async () => {
      const userId = 'user-123';

      mockPrisma.tip.findMany.mockResolvedValue([
        {
          id: 'tip-1',
          creatorId: 'c-1',
          fromUserId: userId,
          amount: 50,
          status: 'completed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await paymentService.getUserTipHistoryCursor(userId, { limit: 5 });

      expect(result.items).toHaveLength(1);
      expect(result.pageInfo).toBeDefined();
    });
  });

  describe('updateTipStatus', () => {
    it('should update tip status and increment creator earnings', async () => {
      const tipId = 'tip-123';
      const creatorId = 'creator-123';

      mockPrisma.tip.findUnique.mockResolvedValueOnce({
        id: tipId,
        creatorId,
        amount: 100,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.tip.updateMany.mockResolvedValue({ count: 1 });

      mockPrisma.creator.update.mockResolvedValue({
        id: creatorId,
        totalEarnings: 100,
        pendingBalance: 100,
      });

      const result = await paymentService.updateTipStatus(tipId, { status: 'completed' });

      expect(result.status).toBe('completed');
      expect(mockPrisma.creator.update).toHaveBeenCalled();
      expect(mockPrisma.tip.updateMany).toHaveBeenCalledWith({
        where: { id: tipId, status: 'pending' },
        data: { status: 'completed' },
      });
    });

    it('should throw NotFoundError if tip does not exist', async () => {
      mockPrisma.tip.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.updateTipStatus('non-existent', { status: 'completed' })
      ).rejects.toThrow(NotFoundError);
    });

    it('does not credit earnings if another worker already changed the status', async () => {
      mockPrisma.tip.findUnique.mockResolvedValueOnce({
        id: 'tip-race', creatorId: 'creator-123', amount: 100, status: 'pending',
      });
      mockPrisma.tip.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        paymentService.updateTipStatus('tip-race', { status: 'completed' }),
      ).rejects.toThrow('changed concurrently');
      expect(mockPrisma.creator.update).not.toHaveBeenCalled();
    });
  });
});
