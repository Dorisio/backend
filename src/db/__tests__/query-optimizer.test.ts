import { describe, it, expect, vi } from 'vitest';
import {
  createPreparedStatement,
  PREPARED_STATEMENTS,
  explainQuery,
} from '../query-optimizer';

describe('QueryOptimizer', () => {
  it('should create prepared statement definitions', () => {
    const ps = createPreparedStatement(
      'get_user',
      'SELECT * FROM "User" WHERE id = $1',
      ['user_123']
    );
    expect(ps.name).toBe('get_user');
    expect(ps.text).toBe('SELECT * FROM "User" WHERE id = $1');
    expect(ps.values).toEqual(['user_123']);
  });

  it('should export standard prepared statements with required fields', () => {
    expect(PREPARED_STATEMENTS.HEALTH_CHECK.name).toBeDefined();
    expect(PREPARED_STATEMENTS.FIND_USER_BY_ID.name).toBeDefined();
    expect(PREPARED_STATEMENTS.FIND_USER_BY_EMAIL.name).toBeDefined();
    expect(PREPARED_STATEMENTS.FIND_CREATOR_BY_USER_ID.name).toBeDefined();
    expect(PREPARED_STATEMENTS.FIND_WALLET_BY_ADDRESS.name).toBeDefined();
    expect(PREPARED_STATEMENTS.GET_CONFIRMED_TIPS_BY_CREATOR.name).toBeDefined();
    expect(PREPARED_STATEMENTS.GET_TIPS_AGGREGATE_BY_CREATOR.name).toBeDefined();
  });

  it('should explain query plan and generate recommendations for sequential scans', async () => {
    const mockExecutor = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Relation Name': 'Tip',
              'Total Cost': 1500,
            },
            'Execution Time': 45.2,
          },
        ],
      }),
    } as any;

    const planResult = await explainQuery(
      mockExecutor,
      'SELECT * FROM "Tip" WHERE status = $1',
      ['pending']
    );

    expect(planResult.hasSequentialScan).toBe(true);
    expect(planResult.estimatedCost).toBe(1500);
    expect(planResult.recommendations.length).toBeGreaterThan(0);
    expect(
      planResult.recommendations.some((r) => r.includes('Sequential scan detected'))
    ).toBe(true);
  });
});
