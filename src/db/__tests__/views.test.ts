import { describe, it, expect, vi } from 'vitest';
import { initializeDatabaseViews, DATABASE_VIEWS } from '../views';

describe('Database Views', () => {
  it('should define SQL statements for all required views', () => {
    expect(DATABASE_VIEWS.CREATOR_ANALYTICS_SUMMARY).toContain('creator_analytics_summary_view');
    expect(DATABASE_VIEWS.DAILY_EARNINGS).toContain('daily_earnings_view');
    expect(DATABASE_VIEWS.TOP_SUPPORTERS).toContain('top_supporters_view');
  });

  it('should execute DDL queries on pool during initialization', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({}),
    } as any;

    await initializeDatabaseViews(mockPool);
    expect(mockPool.query).toHaveBeenCalledTimes(Object.keys(DATABASE_VIEWS).length);
  });
});
