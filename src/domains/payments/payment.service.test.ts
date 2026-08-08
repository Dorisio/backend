import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentService } from './payment.service';
import { ValidationError, NotFoundError } from '../../utils/errors';

// Mock Prisma
const mockPrisma = {
  creator: {
    findUnique: vi.fn(),
    update: vi.fn(),
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
  },
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

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
        isPublic: true,
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
      });
    });

    it('should throw NotFoundError if tip does not exist', async () => {
      mockPrisma.tip.findUnique.mockResolvedValue(null);

      await expect(paymentService.getTip('non-existent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('listTips', () => {
    it('should list tips with pagination', async () => {
      const creatorId = 'creator-123';

      mockPrisma.creator.findUnique.mockResolvedValue({
        id: creatorId,
      });

      mockPrisma.tip.findMany.mockResolvedValue([
        {
          id: 'tip-1',
          amount: 100,
          status: 'completed',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'tip-2',
          amount: 50,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockPrisma.tip.count.mockResolvedValue(2);

      const result = await paymentService.listTips(creatorId, 1, 10);

      expect(result.tips).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
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
      });

      mockPrisma.tip.update.mockResolvedValue({
        id: tipId,
        creatorId,
        amount: 100,
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.creator.update.mockResolvedValue({
        id: creatorId,
        totalEarnings: 100,
        pendingBalance: 100,
      });

      const result = await paymentService.updateTipStatus(tipId, { status: 'completed' });

      expect(result.status).toBe('completed');
      expect(mockPrisma.creator.update).toHaveBeenCalled();
    });

    it('should throw NotFoundError if tip does not exist', async () => {
      mockPrisma.tip.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.updateTipStatus('non-existent', { status: 'completed' })
      ).rejects.toThrow(NotFoundError);
    });
  });
});
