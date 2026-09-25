import { logger } from '../utils/logger';
import { getRequestId } from '../utils/request-context';

export interface QueryLogOptions {
  slowQueryThresholdMs?: number;
  logQueries?: boolean;
  /** Maximum number of slow queries retained in memory for inspection. */
  slowQueryHistorySize?: number;
}

export interface QueryLogContext {
  queryName?: string;
  /** Raw SQL. Optional for ORM queries that are logged by operation name. */
  sql?: string;
  /** Normalized SQL with literals replaced by placeholders (used for grouping). */
  fingerprint?: string;
  /** Operation identifier, e.g. `User.findUnique` or `SELECT`. */
  operation?: string;
  params?: unknown[] | Record<string, unknown>;
  durationMs: number;
  rowCount?: number | null;
  error?: unknown;
}

export interface SlowQueryRecord {
  queryName: string;
  operation: string;
  fingerprint: string;
  durationMs: number;
  rowCount?: number | null;
  occurredAt: string;
}

/** Strings longer than this are truncated before being logged. */
const MAX_PARAM_LENGTH = 500;
/** How much of an oversized string survives truncation. */
const PARAM_PREVIEW_LENGTH = 100;

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

/**
 * Replaces literal values with placeholders so structurally identical queries
 * share a single fingerprint. This keeps slow-query grouping and metric labels
 * bounded (no per-value cardinality).
 */
export function normalizeSql(sql: string): string {
  if (!sql) return '';

  return sql
    // strip comments so they do not create distinct fingerprints
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // string literals
    .replace(/'(?:''|[^'])*'/g, '?')
    // numeric literals
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    // IN (?, ?, ?) -> IN (?)
    .replace(/\?(?:\s*,\s*\?)+/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeQueryName(queryName?: string): string {
  if (!queryName) return 'unnamed_query';
  return queryName.replace(/[^a-zA-Z0-9_.:]/g, '_').slice(0, 120);
}

export function sanitizeParams(
  params?: unknown[] | Record<string, unknown>
): unknown[] | Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined;

  const sanitizeValue = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;

    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return { name: value.name, message: value.message };

    if (typeof value === 'object') {
      try {
        const copy: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          copy[key] = SENSITIVE_PARAM_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitizeValue(nested);
        }
        return copy;
      } catch {
        return '[COMPLEX_OBJECT]';
      }
    }

    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      return `${value.substring(0, PARAM_PREVIEW_LENGTH)}...[TRUNCATED ${value.length} bytes]`;
    }

    return value;
  };

  if (Array.isArray(params)) {
    return params.map(sanitizeValue);
  }

  if (typeof params === 'object') {
    return sanitizeValue(params) as Record<string, unknown>;
  }

  return undefined;
}

export function sanitizeSql(sql: string): string {
  return collapseWhitespace(sql);
}

/**
 * Collapses runs of whitespace so cosmetic formatting does not create distinct
 * fingerprints, cache keys or log lines.
 */
export function collapseWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export class QueryLogger {
  private slowQueryThresholdMs: number;
  private logQueries: boolean;
  private readonly slowQueryHistorySize: number;
  private readonly slowQueries: SlowQueryRecord[] = [];
  private slowQueryCount = 0;

  constructor(options: QueryLogOptions = {}) {
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 200;
    this.logQueries = options.logQueries ?? false;
    this.slowQueryHistorySize = options.slowQueryHistorySize ?? 100;
  }

  public setSlowQueryThreshold(ms: number): void {
    this.slowQueryThresholdMs = ms;
  }

  public getSlowQueryThreshold(): number {
    return this.slowQueryThresholdMs;
  }

  public setLogQueries(enabled: boolean): void {
    this.logQueries = enabled;
  }

  public getLogQueries(): boolean {
    return this.logQueries;
  }

  public getSlowQueries(): SlowQueryRecord[] {
    return [...this.slowQueries];
  }

  public resetSlowQueries(): void {
    this.slowQueries.length = 0;
    this.slowQueryCount = 0;
  }

  public getSlowQueryCount(): number {
    return this.slowQueryCount;
  }

  public logQuery(context: QueryLogContext): void {
    const { queryName, sql, params, durationMs, rowCount, error, operation } = context;
    const safeName = normalizeQueryName(queryName ?? operation);
    const cleanSql = sql ? sanitizeSql(sql) : undefined;
    const safeParams = sanitizeParams(params);
    const fingerprint = context.fingerprint ?? (sql ? normalizeSql(sql) : normalizeQueryName(operation));
    const isSlow = durationMs >= this.slowQueryThresholdMs;

    if (error) {
      logger.error(
        {
          queryName,
          requestId: getRequestId(),
          sql: cleanSql,
          params: safeParams,
          durationMs,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Database query failed'
      );
      return;
    }

    if (isSlow) {
      this.recordSlowQuery({
        queryName: safeName,
        operation: operation ?? cleanSql ?? 'unknown',
        fingerprint,
        durationMs,
        rowCount,
        occurredAt: new Date().toISOString(),
      });

      logger.warn(
        {
          queryName: queryName ?? 'unnamed_query',
          requestId: getRequestId(),
          sql: cleanSql,
          params: safeParams,
          durationMs: Math.round(durationMs * 100) / 100,
          rowCount,
          thresholdMs: this.slowQueryThresholdMs,
        },
        `Slow database query detected (${durationMs.toFixed(2)}ms >= ${this.slowQueryThresholdMs}ms)`
      );
    } else if (this.logQueries) {
      logger.debug(
        {
          queryName,
          requestId: getRequestId(),
          sql: cleanSql,
          params: safeParams,
          durationMs: Math.round(durationMs * 100) / 100,
          rowCount,
        },
        'Database query executed'
      );
    }
  }

  private recordSlowQuery(record: SlowQueryRecord): void {
    this.slowQueryCount++;
    this.slowQueries.unshift(record);
    if (this.slowQueries.length > this.slowQueryHistorySize) {
      this.slowQueries.length = this.slowQueryHistorySize;
    }
  }
}
