import { Pool, PoolClient, QueryResult } from 'pg';
import { logger } from '../utils/logger';

export interface PreparedStatementConfig {
  name: string;
  text: string;
  values?: unknown[];
}

export interface QueryPlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Total Cost'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  Plans?: QueryPlanNode[];
  [key: string]: unknown;
}

export interface QueryPlanResult {
  planText: string;
  planJson?: QueryPlanNode;
  hasSequentialScan: boolean;
  estimatedCost: number;
  executionTimeMs?: number;
  recommendations: string[];
}

// Common prepared statement definitions
export const PREPARED_STATEMENTS = {
  HEALTH_CHECK: {
    name: 'ps_health_check',
    text: 'SELECT 1 AS healthy, NOW() AS server_time;',
  },
  FIND_USER_BY_ID: {
    name: 'ps_find_user_by_id',
    text: 'SELECT id, email, name, role, verified, "createdAt", "updatedAt" FROM "User" WHERE id = $1 LIMIT 1;',
  },
  FIND_USER_BY_EMAIL: {
    name: 'ps_find_user_by_email',
    text: 'SELECT id, email, password, name, role, verified FROM "User" WHERE email = $1 LIMIT 1;',
  },
  FIND_CREATOR_BY_USER_ID: {
    name: 'ps_find_creator_by_user_id',
    text: 'SELECT * FROM "Creator" WHERE "userId" = $1 LIMIT 1;',
  },
  FIND_WALLET_BY_ADDRESS: {
    name: 'ps_find_wallet_by_address',
    text: 'SELECT * FROM "Wallet" WHERE "publicKey" = $1 LIMIT 1;',
  },
  GET_CONFIRMED_TIPS_BY_CREATOR: {
    name: 'ps_get_confirmed_tips_by_creator',
    text: 'SELECT * FROM "Tip" WHERE "creatorId" = $1 AND status = $2 ORDER BY "createdAt" DESC LIMIT $3;',
  },
  GET_TIPS_AGGREGATE_BY_CREATOR: {
    name: 'ps_get_tips_aggregate_by_creator',
    text: 'SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total FROM "Tip" WHERE "creatorId" = $1 AND status = $2;',
  },
} as const;

export function createPreparedStatement(
  name: string,
  text: string,
  values?: unknown[]
): PreparedStatementConfig {
  return {
    name,
    text,
    values,
  };
}

export async function explainQuery(
  executor: Pool | PoolClient,
  sql: string,
  params: unknown[] = [],
  analyze = false
): Promise<QueryPlanResult> {
  const explainSql = analyze
    ? `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`
    : `EXPLAIN (FORMAT JSON) ${sql}`;

  try {
    const result: QueryResult = await executor.query(explainSql, params);
    const rawPlan = result.rows[0];
    const planWrapper = (rawPlan?.['QUERY PLAN'] ?? rawPlan?.[0]?.['Plan'] ?? rawPlan) as unknown;
    
    let rootPlan: QueryPlanNode | undefined;
    if (Array.isArray(planWrapper) && planWrapper[0]?.Plan) {
      rootPlan = planWrapper[0].Plan as QueryPlanNode;
    } else if (typeof planWrapper === 'object' && planWrapper !== null && 'Plan' in planWrapper) {
      rootPlan = (planWrapper as { Plan: QueryPlanNode }).Plan;
    } else if (typeof planWrapper === 'object' && planWrapper !== null) {
      rootPlan = planWrapper as QueryPlanNode;
    }

    const hasSeqScan = checkForSeqScan(rootPlan);
    const estimatedCost = rootPlan?.['Total Cost'] ?? 0;
    const executionTimeMs = (rawPlan as Record<string, unknown>)?.[0]?.['Execution Time'] as number | undefined;

    const recommendations: string[] = [];
    if (hasSeqScan) {
      recommendations.push(
        'Sequential scan detected. Consider creating an index on filtered or joined columns.'
      );
    }
    if (estimatedCost > 1000) {
      recommendations.push(
        `High estimated query cost (${estimatedCost}). Consider index optimization or query refactoring.`
      );
    }

    return {
      planText: JSON.stringify(planWrapper, null, 2),
      planJson: rootPlan,
      hasSequentialScan: hasSeqScan,
      estimatedCost,
      executionTimeMs,
      recommendations,
    };
  } catch (error) {
    logger.error({ error, sql }, 'Failed to explain query');
    throw error;
  }
}

function checkForSeqScan(node?: QueryPlanNode): boolean {
  if (!node) return false;
  if (node['Node Type'] === 'Seq Scan') return true;

  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      if (checkForSeqScan(child)) return true;
    }
  }

  return false;
}
