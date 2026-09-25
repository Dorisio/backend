import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryProfiler } from '../profiler';

describe('QueryProfiler', () => {
  let profiler: QueryProfiler;

  beforeEach(() => {
    profiler = new QueryProfiler({
      slowQueryThresholdMs: 100,
      maxHistorySize: 5,
    });
  });

  it('should initialize with configurable threshold and history bounds', () => {
    expect(profiler.getSlowQueryThreshold()).toBe(100);
    expect(profiler.getSlowQueryHistory()).toEqual([]);
  });

  it('should validate query execution against SLA', () => {
    expect(profiler.checkSLA(50, 100)).toBe(true);
    expect(profiler.checkSLA(100, 100)).toBe(true);
    expect(profiler.checkSLA(101, 100)).toBe(false);
  });

  it('should record slow queries and enforce ring buffer bounds', () => {
    for (let i = 1; i <= 7; i++) {
      profiler.recordQueryExecution(
        `query_${i}`,
        `SELECT * FROM table_${i}`,
        [i],
        100 + i * 10
      );
    }

    const history = profiler.getSlowQueryHistory();
    expect(history).toHaveLength(5); // capped at maxHistorySize 5
    expect(history[0].queryName).toBe('query_3');
    expect(history[4].queryName).toBe('query_7');
    expect(history[4].exceededByMs).toBeGreaterThan(0);
  });

  it('should profile query plan and report recommendations', async () => {
    const mockExecutor = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Relation Name': 'User',
              'Total Cost': 1200,
            },
          },
        ],
      }),
    } as any;

    const profile = await profiler.profileQueryPlan(
      mockExecutor,
      'SELECT * FROM "User" WHERE email = $1',
      ['test@test.com'],
      'find_user_by_email'
    );

    expect(profile.queryName).toBe('find_user_by_email');
    expect(profile.planResult?.hasSequentialScan).toBe(true);
    expect(profile.planResult?.recommendations.length).toBeGreaterThan(0);
  });

  it('should clear slow query history', () => {
    profiler.recordQueryExecution('q1', 'SELECT 1', [], 150);
    expect(profiler.getSlowQueryHistory()).toHaveLength(1);
    profiler.clearSlowQueryHistory();
    expect(profiler.getSlowQueryHistory()).toHaveLength(0);
  });
});
