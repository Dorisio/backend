import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentService } from '../payment.service';

describe('PaymentService Cursor Pagination', () => {
  let paymentService: PaymentService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      creator: {
        findUnique: vi.fn().mockResolvedValue({ id: 'creator_1' }),
      },
      tip: {
        findMany: vi.fn().mockImplementation(async (args: any) => {
          const limit = args.take ?? 21;
          const sampleTips = Array.from({ length: 15 }, (_, i) => ({
            id: `tip_${i + 1}`,
            fromUserId: 'user_1',
            creatorId: 'creator_1',
            amount: 25 * (i + 1),
            message: `Tip ${i + 1}`,
            status: 'confirmed',
            transactionHash: `tx_${i + 1}`,
            createdAt: new Date(1700000000000 - i * 60000),
            updatedAt: new Date(1700000000000 - i * 60000),
          }));
          return sampleTips.slice(0, limit);
        }),
      },
    };

    paymentService = new PaymentService(mockPrisma);
  });

  it('should paginate creator tips with cursor', async () => {
    const result = await paymentService.listTipsCursor('creator_1', { first: 5 });

    expect(result.edges).toHaveLength(5);
    expect(result.edges[0].node.id).toBe('tip_1');
    expect(result.edges[0].cursor).toBeDefined();
    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.pageInfo.startCursor).toBeDefined();
    expect(result.pageInfo.endCursor).toBeDefined();
  });

  it('should paginate user tip history with cursor', async () => {
    const result = await paymentService.getUserTipHistoryCursor('user_1', { first: 5 });

    expect(result.edges).toHaveLength(5);
    expect(result.edges[0].node.id).toBe('tip_1');
    expect(result.pageInfo.hasNextPage).toBe(true);
  });
});
