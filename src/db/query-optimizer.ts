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
  'Alias'?: string;
  'Index Name'?: string;
  'Scan Direction'?: string;
  'Join Type'?: string;
  'Total Cost'?: number;
  'Startup Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Total Time'?: number;
  'Actual Startup Time'?: number;
  'Actual Rows'?: number;
  'Plans'?: QueryPlanNode[];
  [key: string]: unknown;
}

export interface ExplainOptions {
  /** Run the statement to collect real timings. Executes the query. */
  analyze?: boolean;
  buffers?: boolean;
  verbose?: boolean;
  settings?: boolean;
  wal?: boolean;
  format?: 'json' | 'text';
}

export interface QueryPlanResult {
  planText: string;
  planJson?: QueryPlanNode;
  planRoot?: QueryPlanNode;
  hasSequentialScan: boolean;
  estimatedCost: number;
  planningTimeMs?: number;
  executionTimeMs?: number;
  totalActualTimeMs?: number;
  actualRows?: number;
  estimatedRows?: number;
  indexNames: string[];
  relations: string[];
  sequentialScans: string[];
  sortNodes: QueryPlanNode[];
  hashJoins: number;
  hasRowEstimateMismatch: boolean;
  buffersSharedHit?: number;
  buffersSharedRead?: number;
  recommendations: string[];
  raw: unknown;
}

const HIGH_COST_THRESHOLD = 1000;
const ROW_ESTIMATE_MISMATCH_FACTOR = 100;
const LARGE_SORT_ROWS = 10_000;

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
    text: 'SELECT id, "userId", username, "displayName", "totalEarnings", "pendingBalance" FROM "Creator" WHERE "userId" = $1 LIMIT 1;',
  },
  FIND_WALLET_BY_ADDRESS: {
    name: 'ps_find_wallet_by_address',
    text: 'SELECT id, "userId", "publicKey", verified FROM "Wallet" WHERE "publicKey" = $1 LIMIT 1;',
  },
  GET_CONFIRMED_TIPS_BY_CREATOR: {
    name: 'ps_get_confirmed_tips_by_creator',
    text: `SELECT id, "fromUserId", "creatorId", amount, status, "createdAt"
FROM "Tip"
WHERE "creatorId" = $1 AND status = $2
ORDER BY "createdAt" DESC, id DESC
LIMIT $3;`,
  },
  GET_TIPS_AGGREGATE_BY_CREATOR: {
    name: 'ps_get_tips_aggregate_by_creator',
    text: `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total
FROM "Tip"
WHERE "creatorId" = $1 AND status = $2;`,
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

function buildExplainSql(sql: string, options: ExplainOptions): string {
  const parts: string[] = [];
  if (options.analyze) parts.push('ANALYZE');
  if (options.buffers) parts.push('BUFFERS');
  if (options.verbose) parts.push('VERBOSE');
  if (options.settings) parts.push('SETTINGS');
  if (options.wal) parts.push('WAL');
  parts.push('FORMAT JSON');
  return `EXPLAIN (${parts.join(', ')}) ${sql}`;
}

interface ExtractedPlan {
  root?: QueryPlanNode;
  document: unknown;
  planningTimeMs?: number;
  executionTimeMs?: number;
}

/**
 * Normalizes the several shapes PostgreSQL can return for
 * `EXPLAIN (FORMAT JSON)` (already-parsed array, stringified JSON, or a plain
 * plan object).
 */
function extractPlan(rawPlan: unknown): ExtractedPlan {
  let candidate: unknown = rawPlan;

  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { document: rawPlan };
    }
  }

  if (Array.isArray(candidate)) {
    const first: Record<string, unknown> | undefined = candidate[0];
    if (first && typeof first === 'object' && 'Plan' in first) {
      return {
        root: first.Plan as QueryPlanNode,
        document: candidate,
        planningTimeMs: numberOrUndefined(first['Planning Time']),
        executionTimeMs: numberOrUndefined(first['Execution Time']),
      };
    }
    return { document: candidate, root: candidate[0] as QueryPlanNode | undefined };
  }

  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    if ('QUERY PLAN' in record) {
      return extractPlan(record['QUERY PLAN']);
    }
    if ('Plan' in record) {
      const wrapper = record as { Plan: QueryPlanNode; 'Planning Time'?: number; 'Execution Time'?: number };
      return {
        root: wrapper.Plan,
        document: candidate,
        planningTimeMs: numberOrUndefined(wrapper['Planning Time']),
        executionTimeMs: numberOrUndefined(wrapper['Execution Time']),
      };
    }
    return { root: candidate as QueryPlanNode, document: candidate };
  }

  return { document: rawPlan };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function walkPlan(
  node: QueryPlanNode | undefined,
  visit: (node: QueryPlanNode, depth: number) => void,
  depth = 0
): void {
  if (!node) return;
  visit(node, depth);
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) {
      walkPlan(child, visit, depth + 1);
    }
  }
}

function collectBuffers(node: QueryPlanNode | undefined): { sharedHit: number; sharedRead: number } {
  let sharedHit = 0;
  let sharedRead = 0;

  walkPlan(node, (current) => {
    const buffers = current['Shared Hit Blocks'] as unknown;
    const blocks = current['Shared Read Blocks'] as unknown;
    if (typeof buffers === 'number') sharedHit += buffers;
    if (typeof blocks === 'number') sharedRead += blocks;
  });

  return { sharedHit, sharedRead };
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

export function analyzeQueryPlan(planJson?: QueryPlanNode): Omit<
  QueryPlanResult,
  'planText' | 'raw' | 'planJson' | 'planRoot'
> {
  const recommendations: string[] = [];
  const indexNames: string[] = [];
  const relations: string[] = [];
  const sequentialScans: string[] = [];
  const sortNodes: QueryPlanNode[] = [];
  let hashJoins = 0;
  let maxActualTime = 0;
  let actualRows = 0;
  let hasRowEstimateMismatch = false;

  walkPlan(planJson, (node) => {
    const nodeType = (node['Node Type'] as string) || 'Unknown';
    const relation = (node['Relation Name'] as string) || undefined;

    if (relation && !relations.includes(relation)) {
      relations.push(relation);
    }

    if (node['Index Name']) {
      const indexName = node['Index Name'] as string;
      if (!indexNames.includes(indexName)) {
        indexNames.push(indexName);
      }
    }

    if (nodeType === 'Seq Scan' && relation) {
      sequentialScans.push(relation);
    }

    if (nodeType === 'Sort') {
      sortNodes.push(node);
    }

    if (nodeType.includes('Hash Join')) {
      hashJoins++;
    }

    if (typeof node['Actual Total Time'] === 'number') {
      maxActualTime = Math.max(maxActualTime, node['Actual Total Time'] as number);
    }

    const nodeActualRows = numberOrUndefined(node['Actual Rows']);
    const nodePlanRows = numberOrUndefined(node['Plan Rows']);
    if (nodeActualRows !== undefined && nodePlanRows !== undefined) {
      actualRows += nodeActualRows;
      if (nodePlanRows > 0 && nodeActualRows / nodePlanRows >= ROW_ESTIMATE_MISMATCH_FACTOR) {
        hasRowEstimateMismatch = true;
      } else if (nodePlanRows > nodeActualRows * ROW_ESTIMATE_MISMATCH_FACTOR && nodeActualRows > 0) {
        hasRowEstimateMismatch = true;
      }
    }
  });

  const estimatedCost = numberOrUndefined(planJson?.['Total Cost']) ?? 0;

  if (sequentialScans.length > 0) {
    recommendations.push(
      `Sequential scan detected on: ${sequentialScans.join(', ')}. Consider adding an index covering the filtered/joined columns (filter + sort columns make a good composite index).`
    );
  }

  if (estimatedCost > HIGH_COST_THRESHOLD) {
    recommendations.push(
      `High estimated query cost (${estimatedCost}). Consider index optimization, a narrower projection, or query refactoring.`
    );
  }

  const largeSort = sortNodes.find(
    (node) => (numberOrUndefined(node['Plan Rows']) ?? 0) > LARGE_SORT_ROWS
  );
  if (largeSort) {
    recommendations.push(
      `Sort of ~${largeSort['Plan Rows']} rows detected. Add a composite index matching the ORDER BY columns to avoid a full sort.`
    );
  }

  if (hasRowEstimateMismatch) {
    recommendations.push(
      'Row estimates differ significantly from actual rows. Run ANALYZE on the affected tables (or consider extended statistics) so the planner picks better plans.'
    );
  }

  if (hashJoins > 3) {
    recommendations.push(
      `${hashJoins} hash joins detected. Check join indexes; nested loop with indexed lookups is often cheaper for selective joins.`
    );
  }

  if (planJson && indexNames.length === 0 && sequentialScans.length === 0) {
    recommendations.push(
      'No index usage detected on this plan. Verify that the statement is expected to scan a small in-memory relation.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('No obvious performance problems detected in this plan.');
  }

  const buffers = collectBuffers(planJson);

  return {
    hasSequentialScan: sequentialScans.length > 0,
    estimatedCost,
    indexNames,
    relations,
    sequentialScans,
    sortNodes,
    hashJoins,
    hasRowEstimateMismatch,
    totalActualTimeMs: maxActualTime || undefined,
    actualRows: actualRows || undefined,
    buffersSharedHit: buffers.sharedHit || undefined,
    buffersSharedRead: buffers.sharedRead || undefined,
    recommendations,
  };
}

export async function explainQueryWithOptions(
  executor: Pool | PoolClient,
  sql: string,
  params: unknown[] = [],
  options: ExplainOptions = {}
): Promise<QueryPlanResult> {
  if (!options.analyze) {
    const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
    return runExplain(executor, explainSql, params, sql);
  }

  const explainSql = buildExplainSql(sql, options);
  return runExplain(executor, explainSql, params, sql);
}

async function runExplain(
  executor: Pool | PoolClient,
  explainSql: string,
  params: unknown[],
  sql: string
): Promise<QueryPlanResult> {
  try {
    const result: QueryResult = await executor.query(explainSql, params);
    const extracted = extractPlan(result.rows[0]);
    const analysis = analyzeQueryPlan(extracted.root);

    let planText: string;
    try {
      planText = JSON.stringify(extracted.document, null, 2) ?? '';
    } catch {
      planText = String(extracted.document);
    }

    return {
      ...analysis,
      planText,
      planJson: extracted.root,
      planRoot: extracted.root,
      planningTimeMs: extracted.planningTimeMs,
      executionTimeMs: extracted.executionTimeMs,
      raw: result.rows[0],
    };
  } catch (error) {
    logger.error({ error, sql }, 'Failed to explain query');
    throw error;
  }
}

/**
 * Backwards-compatible helper. Pass `analyze = true` to execute the statement
 * and collect real timings (use with care: EXPLAIN ANALYZE runs the query).
 */
export async function explainQuery(
  executor: Pool | PoolClient,
  sql: string,
  params: unknown[] = [],
  analyze = false
): Promise<QueryPlanResult> {
  return explainQueryWithOptions(executor, sql, params, { analyze });
}

export function checkForSequentialScan(node?: QueryPlanNode): boolean {
  return checkForSeqScan(node);
}
