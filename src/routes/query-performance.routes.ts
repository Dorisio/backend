import { FastifyInstance, type FastifySchema } from 'fastify';
import { z } from 'zod';
import { getDatabase, getQueryCache } from '../db/connection';
import { explainQueryWithOptions, type QueryPlanResult } from '../db/query-optimizer';
import { getPrismaPerformanceMonitor } from '../db/prisma-performance';
import { ValidationError } from '../utils/errors';
import { getQueryAnalysisService } from '../services/query-analysis.service';

const ExplainQuerySchema = z.object({
  sql: z.string().min(1, 'sql is required'),
  params: z.array(z.unknown()).optional(),
  analyze: z.boolean().default(false),
  buffers: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

/** Statements that are never allowed through the plan endpoint. */
const FORBIDDEN_STATEMENTS =
  /^\s*(insert|update|delete|truncate|create|alter|drop|grant|revoke|copy|do|call|merge|vacuum|reindex)\b/i;

export const registerQueryPerformanceRoutes = (app: FastifyInstance): void => {
  const queryAnalysis = getQueryAnalysisService(getDatabase());

  /**
   * GET /diagnostics/queries/performance
   * Aggregated Prisma query timings, cache effectiveness and recent slow queries.
   */
  app.get(
    '/diagnostics/queries/performance',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Query performance metrics',
        description:
          'Aggregated per-operation query timings, slow query list, read cache hit rate and unbounded read count.',
      } as unknown as FastifySchema,
    },
    async () => {
      const monitor = getPrismaPerformanceMonitor();
      return {
        stats: monitor.getStats(),
        slowQueries: monitor.getSlowQueries(),
        rawQueryCache: getQueryCache().getStats(),
      };
    }
  );

  /**
   * POST /diagnostics/queries/explain
   * Runs EXPLAIN (FORMAT JSON) for a read-only statement and returns the parsed
   * plan together with optimization recommendations.
   */
  app.post(
    '/diagnostics/queries/explain',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Explain a SQL query',
        description:
          'Runs EXPLAIN (FORMAT JSON) against the read-only statement and returns the parsed plan, index usage and recommendations.',
        body: {
          type: 'object',
          required: ['sql'],
          properties: {
            sql: { type: 'string' },
            params: { type: 'array' },
            analyze: { type: 'boolean', default: false },
            buffers: { type: 'boolean', default: false },
            verbose: { type: 'boolean', default: false },
          },
        },
      } as unknown as FastifySchema,
    },
    async (request) => {
      const parsed = ExplainQuerySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(
          `Invalid explain request: ${parsed.error.issues.map((i) => i.message).join(', ')}`
        );
      }

      const { sql, params = [], analyze, buffers, verbose } = parsed.data;

      if (FORBIDDEN_STATEMENTS.test(sql)) {
        throw new ValidationError('Only read-only statements can be explained');
      }

      const plan: QueryPlanResult = await explainQueryWithOptions(
        getDatabase(),
        sql,
        params,
        { analyze, buffers, verbose }
      );

      return plan;
    }
  );

  /**
   * GET /diagnostics/queries/slow
   * Get slow queries from pg_stat_statements (>100ms average)
   */
  app.get(
    '/diagnostics/queries/slow',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Get slow queries',
        description: 'Returns queries with average execution time >100ms from pg_stat_statements',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 20, description: 'Maximum number of queries to return' },
          },
        },
      } as unknown as FastifySchema,
    },
    async (request) => {
      const limit = (request.query as any)?.limit || 20;
      const slowQueries = await queryAnalysis.getSlowQueries(limit);
      return { slowQueries, count: slowQueries.length };
    }
  );

  /**
   * GET /diagnostics/queries/report
   * Generate comprehensive performance report
   */
  app.get(
    '/diagnostics/queries/report',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Performance analysis report',
        description:
          'Comprehensive report including slow queries, top queries, missing indexes, and optimization recommendations',
      } as unknown as FastifySchema,
    },
    async () => {
      return await queryAnalysis.generatePerformanceReport();
    }
  );

  /**
   * GET /diagnostics/queries/statistics
   * Get overall pg_stat_statements summary
   */
  app.get(
    '/diagnostics/queries/statistics',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Query statistics summary',
        description: 'Overall statistics from pg_stat_statements including total calls, time, and unique queries',
      } as unknown as FastifySchema,
    },
    async () => {
      return await queryAnalysis.getStatisticsSummary();
    }
  );

  /**
   * POST /diagnostics/queries/analyze
   * Analyze a specific query with EXPLAIN ANALYZE and get recommendations
   */
  app.post(
    '/diagnostics/queries/analyze',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Analyze query and get recommendations',
        description: 'Runs EXPLAIN ANALYZE and provides optimization recommendations',
        body: {
          type: 'object',
          required: ['sql'],
          properties: {
            sql: { type: 'string' },
            params: { type: 'array' },
          },
        },
      } as unknown as FastifySchema,
    },
    async (request) => {
      const { sql, params = [] } = request.body as { sql: string; params?: unknown[] };

      if (FORBIDDEN_STATEMENTS.test(sql)) {
        throw new ValidationError('Only read-only statements can be analyzed');
      }

      return await queryAnalysis.analyzeQuery(sql, params);
    }
  );

  /**
   * GET /diagnostics/queries/missing-indexes
   * Identify tables that may benefit from indexes
   */
  app.get(
    '/diagnostics/queries/missing-indexes',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Identify missing indexes',
        description: 'Analyzes sequential scans to suggest tables that need indexes',
      } as unknown as FastifySchema,
    },
    async () => {
      const suggestions = await queryAnalysis.identifyMissingIndexes();
      return { suggestions, count: suggestions.length };
    }
  );

  /**
   * POST /diagnostics/queries/enable-monitoring
   * Enable pg_stat_statements extension
   */
  app.post(
    '/diagnostics/queries/enable-monitoring',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Enable query monitoring',
        description: 'Enables pg_stat_statements extension for query performance tracking',
      } as unknown as FastifySchema,
    },
    async () => {
      const enabled = await queryAnalysis.enablePgStatStatements();
      return { enabled, message: enabled ? 'Monitoring enabled' : 'Failed to enable monitoring' };
    }
  );

  /**
   * POST /diagnostics/queries/reset-statistics
   * Reset pg_stat_statements statistics
   */
  app.post(
    '/diagnostics/queries/reset-statistics',
    {
      schema: {
        tags: ['Diagnostics'],
        summary: 'Reset query statistics',
        description: 'Resets all pg_stat_statements statistics',
      } as unknown as FastifySchema,
    },
    async () => {
      const reset = await queryAnalysis.resetStatistics();
      return { reset, message: reset ? 'Statistics reset' : 'Failed to reset statistics' };
    }
  );
};
