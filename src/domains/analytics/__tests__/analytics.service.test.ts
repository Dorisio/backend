import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnalyticsService } from '../analytics.service';
import { queryCache } from '../../../db/query-cache';

describe('AnalyticsService (Optimized with Query Caching)', () => {
  let analyticsService: AnalyticsService;
  let mockPrisma: any;

  beforeEach(() => {
    queryCache.clear();

    mockPrisma = {
      tip: {
        findMany: vi.fn().mockResolvedValue([
          {
            amount: 50,
            createdAt: new Date('2026-09-20T10:00:00.000Z'),
          },
          {
            amount: 75,
            createdAt: new Date('2026-09-20T14:00:00.000Z'),
          },
          {
            amount: 100,
            createdAt: new Date('2026-09-21T09:00:00.000Z'),
          },
        ]),
        groupBy: vi.fn().mockResolvedValue([
          {
            fromUserId: 'user_1',
            _sum: { amount: 150 },
            _count: { id: 3 },
            _max: { createdAt: new Date('2026-09-21T10:00:00.000Z') },
          },
        ]),
        aggregate: vi.fn().mockResolvedValue({
          _count: { id: 5 },
          _sum: { amount: 225 },
          _avg: { amount: 45 },
          _max: { amount: 100 },
          _min: { amount: 25 },
        }),
      },
    };

    analyticsService = new AnalyticsService(mockPrisma);
  });

  it('should compute earnings over time and cache the result', async () => {
    const result1 = await analyticsService.getEarningsOverTime('c_1', 30);
    expect(result1).toHaveLength(2);
    expect(result1[0].date).toBe('2026-09-20');
    expect(result1[0].earnings).toBe(125);
    expect(result1[0].tipCount).toBe(2);
    expect(mockPrisma.tip.findMany).toHaveBeenCalledTimes(1);

    // 2nd call should hit cache without querying database
    const result2 = await analyticsService.getEarningsOverTime('c_1', 30);
    expect(result2).toEqual(result1);
    expect(mockPrisma.tip.findMany).toHaveBeenCalledTimes(1);
  });

  it('should compute top supporters and cache the result', async () => {
    const supporters = await analyticsService.getTopSupporters('c_1', 10);
    expect(supporters).toHaveLength(1);
    expect(supporters[0].userId).toBe('user_1');
    expect(supporters[0].totalAmount).toBe(150);
    expect(mockPrisma.tip.groupBy).toHaveBeenCalledTimes(1);

    // 2nd call should hit cache
    await analyticsService.getTopSupporters('c_1', 10);
    expect(mockPrisma.tip.groupBy).toHaveBeenCalledTimes(1);
  });

  it('should compute tip frequency via database aggregate and cache the result', async () => {
    const freq = await analyticsService.getTipFrequency('c_1', 30);
    expect(freq.totalTips).toBe(5);
    expect(freq.totalEarnings).toBe(225);
    expect(freq.averageTipAmount).toBe(45);
    expect(freq.largestTip).toBe(100);
    expect(freq.smallestTip).toBe(25);
    expect(mockPrisma.tip.aggregate).toHaveBeenCalledTimes(1);

    // 2nd call should hit cache
    await analyticsService.getTipFrequency('c_1', 30);
    expect(mockPrisma.tip.aggregate).toHaveBeenCalledTimes(1);
  });

  it('should invalidate creator cache tags properly', async () => {
    await analyticsService.getEarningsOverTime('c_1', 30);
    expect(mockPrisma.tip.findMany).toHaveBeenCalledTimes(1);

    analyticsService.invalidateCreatorCache('c_1');

    await analyticsService.getEarningsOverTime('c_1', 30);
    expect(mockPrisma.tip.findMany).toHaveBeenCalledTimes(2);
  });
});
