import { describe, it, expect, vi } from 'vitest';
import {
  analyzeQueryPlan,
  checkForSequentialScan,
  createPreparedStatement,
  PREPARED_STATEMENTS,
  explainQuery,
  explainQueryWithOptions,
  type QueryPlanNode,
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

describe('analyzeQueryPlan', () => {
  const indexPlan: QueryPlanNode = {
    'Node Type': 'Index Scan',
    'Relation Name': 'Tip',
    'Index Name': 'idx_tip_creator_createdAt',
    'Total Cost': 8.4,
    'Plan Rows': 20,
    'Actual Rows': 20,
    'Actual Total Time': 1.2,
    'Shared Hit Blocks': 3,
  };

  it('reports index usage without false positives', () => {
    const analysis = analyzeQueryPlan(indexPlan);

    expect(analysis.hasSequentialScan).toBe(false);
    expect(analysis.indexNames).toEqual(['idx_tip_creator_createdAt']);
    expect(analysis.relations).toEqual(['Tip']);
    expect(analysis.buffersSharedHit).toBe(3);
    expect(analysis.recommendations).toEqual([
      'No obvious performance problems detected in this plan.',
    ]);
  });

  it('detects sequential scans on nested plan nodes', () => {
    const nested: QueryPlanNode = {
      'Node Type': 'Nested Loop',
      'Total Cost': 900,
      'Plan Rows': 500,
      'Actual Rows': 4800,
      Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'Tip', 'Plan Rows': 100, 'Actual Rows': 50_000 }],
    };

    const analysis = analyzeQueryPlan(nested);

    expect(analysis.hasSequentialScan).toBe(true);
    expect(analysis.sequentialScans).toEqual(['Tip']);
    expect(analysis.hasRowEstimateMismatch).toBe(true);
    expect(analysis.recommendations.join(' ')).toContain('Sequential scan detected');
    expect(analysis.recommendations.join(' ')).toContain('Row estimates differ significantly');
  });

  it('flags large sorts, high cost and heavy join counts', () => {
    const heavy: QueryPlanNode = {
      'Node Type': 'Hash Join',
      'Total Cost': 50_000,
      'Plan Rows': 20_000,
      Plans: [
        { 'Node Type': 'Hash Join' },
        { 'Node Type': 'Hash Join' },
        { 'Node Type': 'Hash Join' },
        { 'Node Type': 'Hash Join' },
        { 'Node Type': 'Sort', 'Plan Rows': 20_000 },
      ],
    };

    const recommendations = analyzeQueryPlan(heavy).recommendations.join(' ');

    expect(recommendations).toContain('High estimated query cost');
    expect(recommendations).toContain('Sort of ~20000 rows');
    expect(recommendations).toContain('hash joins');
  });

  it('tolerates an empty or missing plan', () => {
    expect(analyzeQueryPlan(undefined).hasSequentialScan).toBe(false);
    expect(checkForSequentialScan(undefined)).toBe(false);
  });
});

describe('explainQueryWithOptions', () => {
  it('parses the multi-row "QUERY PLAN" shape returned by FORMAT JSON', async () => {
    const plan = {
      'Node Type': 'Seq Scan',
      'Relation Name': 'Tip',
      'Total Cost': 1500,
      'Plan Rows': 100,
      'Actual Rows': 100,
    };
    const executor = {
      query: vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': [{ Plan: plan, 'Execution Time': 12.5 }] }] }),
    } as any;

    const result = await explainQueryWithOptions(executor, 'SELECT * FROM "Tip"');

    expect(executor.query).toHaveBeenCalledWith('EXPLAIN (FORMAT JSON) SELECT * FROM "Tip"', []);
    expect(result.hasSequentialScan).toBe(true);
    expect(result.executionTimeMs).toBe(12.5);
    expect(JSON.parse(result.planText)[0].Plan['Relation Name']).toBe('Tip');
  });

  it('builds an ANALYZE statement only when explicitly requested', async () => {
    const sql = 'SELECT 1';
    const executor = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    await explainQueryWithOptions(executor, sql, [], { analyze: true, buffers: true, verbose: true });

    const issued = executor.query.mock.calls[0][0] as string;
    expect(issued).toContain('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)');
    expect(issued).toContain(sql);
  });

  it('propagates executor errors', async () => {
    const executor = {
      query: vi.fn().mockRejectedValue(new Error('permission denied')),
    } as any;

    await expect(explainQueryWithOptions(executor, 'SELECT 1')).rejects.toThrow('permission denied');
  });
});
