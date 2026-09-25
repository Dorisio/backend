import { describe, it, expect, vi } from 'vitest';
import { paginateWithOffset, paginateWithCursor } from '../pagination';
import { encodeCursor } from '../../utils/pagination';

describe('Database Keyset and Offset Pagination', () => {
  describe('paginateWithOffset', () => {
    it('should query Prisma with correct offset, limit, order, and compute metadata', async () => {
      const mockItems = [
        { id: 'tip_1', amount: 10, createdAt: new Date() },
        { id: 'tip_2', amount: 20, createdAt: new Date() },
      ];

      const mockModel = {
        findMany: vi.fn().mockResolvedValue(mockItems),
        count: vi.fn().mockResolvedValue(45),
      };

      const result = await paginateWithOffset(mockModel as any, { page: 2, pageSize: 20 }, {
        where: { creatorId: 'c_1' },
        allowedSortFields: ['createdAt', 'amount', 'id'],
      });

      expect(mockModel.findMany).toHaveBeenCalledWith({
        where: { creatorId: 'c_1' },
        include: undefined,
        select: undefined,
        skip: 20,
        take: 20,
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(45);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(true);
    });
  });

  describe('paginateWithCursor', () => {
    it('should query Prisma with take: limit + 1 and build pageInfo accurately', async () => {
      const mockTips = Array.from({ length: 21 }, (_, i) => ({
        id: `tip_${i + 1}`,
        amount: (i + 1) * 10,
        createdAt: new Date(),
      }));

      const mockModel = {
        findMany: vi.fn().mockResolvedValue(mockTips),
        count: vi.fn().mockResolvedValue(100),
      };

      const result = await paginateWithCursor(mockModel as any, { limit: 20 }, {
        where: { creatorId: 'c_1' },
      });

      // Should take 21 (limit + 1) to determine if next page exists
      expect(mockModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 21,
          skip: 0,
          cursor: undefined,
        })
      );

      // Should slice down to 20
      expect(result.items).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.pageInfo.hasNextPage).toBe(true);
      expect(result.pageInfo.hasPreviousPage).toBe(false);
      expect(result.nextCursor).toBeDefined();
    });

    it('should use cursor and skip: 1 when after cursor is provided', async () => {
      const afterCursor = encodeCursor({ id: 'tip_20' });
      const mockTips = Array.from({ length: 5 }, (_, i) => ({
        id: `tip_${i + 21}`,
        amount: (i + 21) * 10,
        createdAt: new Date(),
      }));

      const mockModel = {
        findMany: vi.fn().mockResolvedValue(mockTips),
        count: vi.fn().mockResolvedValue(25),
      };

      const result = await paginateWithCursor(mockModel as any, { limit: 20, after: afterCursor });

      expect(mockModel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 21,
          skip: 1,
          cursor: { id: 'tip_20' },
        })
      );

      expect(result.items).toHaveLength(5);
      expect(result.hasMore).toBe(false);
      expect(result.pageInfo.hasNextPage).toBe(false);
      expect(result.pageInfo.hasPreviousPage).toBe(true);
      expect(result.nextCursor).toBeNull();
    });
  });
});
