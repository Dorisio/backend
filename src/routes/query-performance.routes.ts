import { FastifyInstance, type FastifySchema } from 'fastify';
import { z } from 'zod';
import { getDatabase, getQueryCache } from '../db/connection';
import { explainQueryWithOptions, type QueryPlanResult } from '../db/query-optimizer';
import { getPrismaPerformanceMonitor } from '../db/prisma-performance';
import { ValidationError } from '../utils/errors';

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
};
