import { Pool } from 'pg';
import { logger } from '../utils/logger';
import {
  explainQueryWithOptions,
  analyzeQueryPlan,
  type QueryPlanResult,
} from '../db/query-optimizer';

/**
 * Slow query threshold in milliseconds
 */
export const SLOW_QUERY_THRESHOLD_MS = 100;

export interface SlowQuery {
  query: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  maxTimeMs: number;
  minTimeMs: number;
  stddevTimeMs: number;
  rows: number;
  detectedAt: Date;
}

export interface QueryStatistics {
  query: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  maxTimeMs: number;
  minTimeMs: number;
  rows: number;
}

export interface OptimizationRecommendation {
  type: 'missing_index' | 'query_rewrite' | 'table_bloat' | 'analyze_needed' | 'configuration';
  severity: 'high' | 'medium' | 'low';
  query?: string;
  table?: string;
  suggestion: string;
  estimatedImpact: string;
}

export interface PerformanceReport {
  generatedAt: Date;
  totalQueries: number;
  slowQueries: SlowQuery[];
  topQueriesByTime: QueryStatistics[];
  topQueriesByCalls: QueryStatistics[];
  recommendations: OptimizationRecommendation[];
  summary: {
    averageQueryTime: number;
    slowQueryPercentage: number;
    totalQueryTime: number;
    cacheMissRate?: number;
  };
}

export interface MissingIndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  estimatedRows: number;
}

/**
 * Query Analysis Service
 *
 * Provides comprehensive query performance analysis including:
 * - pg_stat_statements integration
 * - Slow query detection (>100ms)
 * - EXPLAIN ANALYZE for query plans
 * - Missing index identification
 * - Query rewrite recommendations
 */
export class QueryAnalysisService {
  constructor(private pool: Pool) {}

  /**
   * Enable pg_stat_statements extension
   */
  async enablePgStatStatements(): Promise<boolean> {
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      logger.info('pg_stat_statements extension enabled');
      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to enable pg_stat_statements');
      return false;
    }
  }

  /**
   * Check if pg_stat_statements is available
   */
  async isPgStatStatementsEnabled(): Promise<boolean> {
    try {
      const result = await this.pool.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) AS enabled
      `);
      return result.rows[0]?.enabled === true;
    } catch (error) {
      logger.error({ error }, 'Failed to check pg_stat_statements status');
      return false;
    }
  }

  /**
   * Get slow queries from pg_stat_statements (>100ms average)
   */
  async getSlowQueries(limit: number = 20): Promise<SlowQuery[]> {
    const enabled = await this.isPgStatStatementsEnabled();
    if (!enabled) {
      logger.warn('pg_stat_statements not enabled, cannot fetch slow queries');
      return [];
    }

    try {
      const result = await this.pool.query<{
        query: string;
        calls: string;
        total_exec_time: string;
        mean_exec_time: string;
        max_exec_time: string;
        min_exec_time: string;
        stddev_exec_time: string;
        rows: string;
      }>(
        `
        SELECT
          query,
          calls,
          total_exec_time,
          mean_exec_time,
          max_exec_time,
          min_exec_time,
          stddev_exec_time,
          rows
        FROM pg_stat_statements
        WHERE mean_exec_time > $1
        ORDER BY mean_exec_time DESC
        LIMIT $2
      `,
        [SLOW_QUERY_THRESHOLD_MS, limit]
      );

      return result.rows.map((row) => ({
        query: row.query,
        calls: parseInt(row.calls, 10),
        totalTimeMs: parseFloat(row.total_exec_time),
        meanTimeMs: parseFloat(row.mean_exec_time),
        maxTimeMs: parseFloat(row.max_exec_time),
        minTimeMs: parseFloat(row.min_exec_time),
        stddevTimeMs: parseFloat(row.stddev_exec_time),
        rows: parseInt(row.rows, 10),
        detectedAt: new Date(),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to fetch slow queries');
      return [];
    }
  }

  /**
   * Get top queries by total execution time
   */
  async getTopQueriesByTime(limit: number = 20): Promise<QueryStatistics[]> {
    const enabled = await this.isPgStatStatementsEnabled();
    if (!enabled) return [];

    try {
      const result = await this.pool.query<{
        query: string;
        calls: string;
        total_exec_time: string;
        mean_exec_time: string;
        max_exec_time: string;
        min_exec_time: string;
        rows: string;
      }>(
        `
        SELECT
          query,
          calls,
          total_exec_time,
          mean_exec_time,
          max_exec_time,
          min_exec_time,
          rows
        FROM pg_stat_statements
        ORDER BY total_exec_time DESC
        LIMIT $1
      `,
        [limit]
      );

      return result.rows.map((row) => ({
        query: row.query,
        calls: parseInt(row.calls, 10),
        totalTimeMs: parseFloat(row.total_exec_time),
        meanTimeMs: parseFloat(row.mean_exec_time),
        maxTimeMs: parseFloat(row.max_exec_time),
        minTimeMs: parseFloat(row.min_exec_time),
        rows: parseInt(row.rows, 10),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to fetch top queries by time');
      return [];
    }
  }

  /**
   * Get top queries by call count
   */
  async getTopQueriesByCalls(limit: number = 20): Promise<QueryStatistics[]> {
    const enabled = await this.isPgStatStatementsEnabled();
    if (!enabled) return [];

    try {
      const result = await this.pool.query<{
        query: string;
        calls: string;
        total_exec_time: string;
        mean_exec_time: string;
        max_exec_time: string;
        min_exec_time: string;
        rows: string;
      }>(
        `
        SELECT
          query,
          calls,
          total_exec_time,
          mean_exec_time,
          max_exec_time,
          min_exec_time,
          rows
        FROM pg_stat_statements
        ORDER BY calls DESC
        LIMIT $1
      `,
        [limit]
      );

      return result.rows.map((row) => ({
        query: row.query,
        calls: parseInt(row.calls, 10),
        totalTimeMs: parseFloat(row.total_exec_time),
        meanTimeMs: parseFloat(row.mean_exec_time),
        maxTimeMs: parseFloat(row.max_exec_time),
        minTimeMs: parseFloat(row.min_exec_time),
        rows: parseInt(row.rows, 10),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to fetch top queries by calls');
      return [];
    }
  }

  /**
   * Identify missing indexes by analyzing sequential scans
   */
  async identifyMissingIndexes(): Promise<MissingIndexSuggestion[]> {
    try {
      // Find tables with high sequential scan counts
      const result = await this.pool.query<{
        schemaname: string;
        tablename: string;
        seq_scan: string;
        seq_tup_read: string;
        idx_scan: string;
        n_live_tup: string;
      }>(`
        SELECT
          schemaname,
          tablename,
          seq_scan,
          seq_tup_read,
          idx_scan,
          n_live_tup
        FROM pg_stat_user_tables
        WHERE seq_scan > 100
          AND n_live_tup > 1000
          AND (idx_scan = 0 OR seq_scan > idx_scan * 2)
        ORDER BY seq_scan DESC
        LIMIT 10
      `);

      const suggestions: MissingIndexSuggestion[] = [];

      for (const row of result.rows) {
        const seqScan = parseInt(row.seq_scan, 10);
        const idxScan = parseInt(row.idx_scan, 10) || 0;
        const rows = parseInt(row.n_live_tup, 10);

        if (seqScan > idxScan * 2 && rows > 1000) {
          suggestions.push({
            table: row.tablename,
            columns: [], // Would need query analysis to determine columns
            reason: `Table has ${seqScan} sequential scans vs ${idxScan} index scans with ${rows} rows`,
            estimatedRows: rows,
          });
        }
      }

      return suggestions;
    } catch (error) {
      logger.error({ error }, 'Failed to identify missing indexes');
      return [];
    }
  }

  /**
   * Analyze a specific query and provide recommendations
   */
  async analyzeQuery(
    query: string,
    params: unknown[] = []
  ): Promise<{
    plan: QueryPlanResult;
    recommendations: OptimizationRecommendation[];
  }> {
    const plan = await explainQueryWithOptions(this.pool, query, params, {
      analyze: true,
      buffers: true,
      verbose: false,
    });

    const recommendations: OptimizationRecommendation[] = [];

    // Convert plan recommendations to structured format
    if (plan.hasSequentialScan) {
      recommendations.push({
        type: 'missing_index',
        severity: 'high',
        query,
        suggestion: `Sequential scan detected on tables: ${plan.sequentialScans.join(', ')}. Add indexes on frequently filtered columns.`,
        estimatedImpact: 'High - can reduce query time by 10-100x',
      });
    }

    if (plan.estimatedCost > 1000) {
      recommendations.push({
        type: 'query_rewrite',
        severity: 'medium',
        query,
        suggestion: `High query cost (${plan.estimatedCost}). Consider adding WHERE clauses, using LIMIT, or splitting into multiple queries.`,
        estimatedImpact: 'Medium - can reduce resource usage significantly',
      });
    }

    if (plan.hasRowEstimateMismatch) {
      recommendations.push({
        type: 'analyze_needed',
        severity: 'medium',
        suggestion:
          'Row estimate mismatch detected. Run ANALYZE on affected tables to update statistics.',
        estimatedImpact: 'Medium - helps planner choose better execution plans',
      });
    }

    if (plan.sortNodes.length > 0) {
      const largeSort = plan.sortNodes.find((node) => (node['Plan Rows'] as number) > 10000);
      if (largeSort) {
        recommendations.push({
          type: 'missing_index',
          severity: 'high',
          query,
          suggestion: 'Large sort operation detected. Add index matching ORDER BY columns.',
          estimatedImpact: 'High - eliminates expensive sort operation',
        });
      }
    }

    return { plan, recommendations };
  }

  /**
   * Generate comprehensive performance report
   */
  async generatePerformanceReport(): Promise<PerformanceReport> {
    const [slowQueries, topByTime, topByCalls, missingIndexes] = await Promise.all([
      this.getSlowQueries(20),
      this.getTopQueriesByTime(20),
      this.getTopQueriesByCalls(20),
      this.identifyMissingIndexes(),
    ]);

    const recommendations: OptimizationRecommendation[] = [];

    // Add missing index recommendations
    for (const missing of missingIndexes) {
      recommendations.push({
        type: 'missing_index',
        severity: 'high',
        table: missing.table,
        suggestion: `${missing.reason}. Consider adding indexes.`,
        estimatedImpact: 'High - can significantly improve query performance',
      });
    }

    // Calculate summary statistics
    const totalQueries = topByCalls.reduce((sum, q) => sum + q.calls, 0);
    const totalQueryTime = topByTime.reduce((sum, q) => sum + q.totalTimeMs, 0);
    const averageQueryTime = totalQueries > 0 ? totalQueryTime / totalQueries : 0;
    const slowQueryCount = slowQueries.length;
    const slowQueryPercentage = totalQueries > 0 ? (slowQueryCount / totalQueries) * 100 : 0;

    return {
      generatedAt: new Date(),
      totalQueries,
      slowQueries,
      topQueriesByTime: topByTime,
      topQueriesByCalls: topByCalls,
      recommendations,
      summary: {
        averageQueryTime,
        slowQueryPercentage,
        totalQueryTime,
      },
    };
  }

  /**
   * Reset pg_stat_statements statistics
   */
  async resetStatistics(): Promise<boolean> {
    const enabled = await this.isPgStatStatementsEnabled();
    if (!enabled) return false;

    try {
      await this.pool.query('SELECT pg_stat_statements_reset()');
      logger.info('pg_stat_statements statistics reset');
      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to reset statistics');
      return false;
    }
  }

  /**
   * Get overall statistics summary
   */
  async getStatisticsSummary(): Promise<{
    totalCalls: number;
    totalTimeMs: number;
    avgTimeMs: number;
    uniqueQueries: number;
  }> {
    const enabled = await this.isPgStatStatementsEnabled();
    if (!enabled) {
      return { totalCalls: 0, totalTimeMs: 0, avgTimeMs: 0, uniqueQueries: 0 };
    }

    try {
      const result = await this.pool.query<{
        total_calls: string;
        total_time: string;
        unique_queries: string;
      }>(`
        SELECT
          SUM(calls)::bigint AS total_calls,
          SUM(total_exec_time)::numeric AS total_time,
          COUNT(*)::int AS unique_queries
        FROM pg_stat_statements
      `);

      const row = result.rows[0];
      const totalCalls = parseInt(row.total_calls, 10) || 0;
      const totalTimeMs = parseFloat(row.total_time) || 0;
      const uniqueQueries = parseInt(row.unique_queries, 10) || 0;

      return {
        totalCalls,
        totalTimeMs,
        avgTimeMs: totalCalls > 0 ? totalTimeMs / totalCalls : 0,
        uniqueQueries,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get statistics summary');
      return { totalCalls: 0, totalTimeMs: 0, avgTimeMs: 0, uniqueQueries: 0 };
    }
  }
}

/**
 * Create a singleton instance
 */
let queryAnalysisService: QueryAnalysisService | null = null;

export function getQueryAnalysisService(pool: Pool): QueryAnalysisService {
  if (!queryAnalysisService) {
    queryAnalysisService = new QueryAnalysisService(pool);
  }
  return queryAnalysisService;
}
