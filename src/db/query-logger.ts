import { logger } from '../utils/logger';
import { queryProfiler } from './profiler';

export interface QueryLogOptions {
  slowQueryThresholdMs?: number;
  logQueries?: boolean;
}

export interface QueryLogContext {
  queryName?: string;
  sql: string;
  params?: unknown[];
  durationMs: number;
  rowCount?: number | null;
  error?: unknown;
}

const SENSITIVE_PARAM_KEYS = new Set([
  'password',
  'secret',
  'token',
  'key',
  'authorization',
  'privatekey',
  'stellar_server_secret_key',
  'hash',
]);

export function sanitizeParams(params?: unknown[]): unknown[] | undefined {
  if (!params || !Array.isArray(params)) return params;

  return params.map((param) => {
    if (param === null || param === undefined) return param;

    if (typeof param === 'object') {
      try {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(param as Record<string, unknown>)) {
          if (SENSITIVE_PARAM_KEYS.has(key.toLowerCase())) {
            copy[key] = '[REDACTED]';
          } else {
            copy[key] = value;
          }
        }
        return copy;
      } catch {
        return '[COMPLEX_OBJECT]';
      }
    }

    if (typeof param === 'string' && param.length > 500) {
      return `${param.substring(0, 100)}...[TRUNCATED ${param.length} bytes]`;
    }

    return param;
  });
}

export function sanitizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export class QueryLogger {
  private slowQueryThresholdMs: number;
  private logQueries: boolean;

  constructor(options: QueryLogOptions = {}) {
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 100;
    this.logQueries = options.logQueries ?? false;
  }

  public setSlowQueryThreshold(ms: number): void {
    this.slowQueryThresholdMs = ms;
  }

  public setLogQueries(enabled: boolean): void {
    this.logQueries = enabled;
  }

  public logQuery(context: QueryLogContext): void {
    const { queryName, sql, params, durationMs, rowCount, error } = context;
    const cleanSql = sanitizeSql(sql);
    const safeParams = sanitizeParams(params);
    const isSlow = durationMs >= this.slowQueryThresholdMs;

    if (error) {
      logger.error(
        {
          queryName,
          sql: cleanSql,
          params: safeParams,
          durationMs,
          error,
        },
        'Database query failed'
      );
      return;
    }

    if (isSlow) {
      queryProfiler.recordQueryExecution(queryName, cleanSql, safeParams, durationMs);
      logger.warn(
        {
          queryName: queryName ?? 'unnamed_query',
          sql: cleanSql,
          params: safeParams,
          durationMs,
          rowCount,
          thresholdMs: this.slowQueryThresholdMs,
        },
        `Slow database query detected (${durationMs.toFixed(2)}ms >= ${this.slowQueryThresholdMs}ms)`
      );
    } else if (this.logQueries) {
      logger.debug(
        {
          queryName,
          sql: cleanSql,
          params: safeParams,
          durationMs,
          rowCount,
        },
        'Database query executed'
      );
    }
  }
}
