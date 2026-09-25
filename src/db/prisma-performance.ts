import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { QueryCache } from './query-cache';
import { QueryLogger, normalizeQueryName } from './query-logger';
import {
  dbCacheSizeGauge,
  prismaCacheHitsCounter,
  prismaCacheMissesCounter,
  prismaQueryCount,
  prismaQueryDuration,
  prismaQueryRows,
  prismaSlowQueriesCounter,
  prismaUnboundedReadsCounter,
} from './metrics';

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Cached reads stay short-lived; writes invalidate the affected model tag. */
export const PRISMA_CACHE_DEFAULT_TTL_MS = 60_000;
const PRISMA_CACHE_MAX_TTL_MS = 5 * 60_000;
const UNBOUNDED_READ_WARN_INTERVAL_MS = 60_000;
/** Guards the recursive projection scan against pathological nesting. */
const MAX_PROJECTION_DEPTH = 5;
const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'secret',
  'token',
  'refreshToken',
  'apiKey',
  'privateKey',
  'secretKey',
  'signingSecret',
  'stellarServerSecretKey',
  'clientSecret',
];

export interface PrismaPerformanceOptions {
  slowQueryThresholdMs?: number;
  logQueries?: boolean;
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  /** Warn (at most once per interval) when a list read has no `take`. */
  warnOnUnboundedReads?: boolean;
}

export interface PrismaOperationStats {
  count: number;
  errors: number;
  cacheHits: number;
  cacheMisses: number;
  totalDurationMs: number;
  maxDurationMs: number;
  slowQueries: number;
  rows: number;
}

export interface PrismaPerformanceStats {
  totalQueries: number;
  totalErrors: number;
  slowQueries: number;
  cacheHits: number;
  cacheMisses: number;
  unboundedReads: number;
  totalDurationMs: number;
  maxDurationMs: number;
  operations: Record<string, PrismaOperationStats>;
  cache: {
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects `select`/`include` projections that would pull credentials or signing
 * material into the process cache. Walks the whole projection tree, since
 * relations are nested arbitrarily deep.
 */
function selectsSensitiveFields(args: Record<string, unknown>, depth = 0): boolean {
  if (depth > MAX_PROJECTION_DEPTH) return false;

  for (const candidate of [args.select, args.include]) {
    if (!isPlainObject(candidate)) continue;

    for (const [key, value] of Object.entries(candidate)) {
      if (SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
        return true;
      }
      if (isPlainObject(value) && selectsSensitiveFields({ select: value }, depth + 1)) {
        return true;
      }
    }
  }

  return false;
}

function countRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return result === null || result === undefined ? 0 : 1;
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return input ?? null;
    if (typeof input === 'bigint') return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(walk);
    if (isPlainObject(input)) {
      if (seen.has(input)) return '[Circular]';
      seen.add(input);
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        sorted[key] = walk((input as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return input;
  };

  try {
    return JSON.stringify(walk(value)) ?? 'null';
  } catch {
    return String(value);
  }
}

export function defaultPrismaPerformanceOptions(): Required<PrismaPerformanceOptions> {
  return {
    slowQueryThresholdMs: config.DB_SLOW_QUERY_THRESHOLD_MS ?? 200,
    logQueries: config.DB_LOG_QUERIES ?? false,
    cacheEnabled: config.DB_QUERY_CACHE_ENABLED !== false,
    cacheTtlMs: config.DB_QUERY_CACHE_TTL_MS ?? PRISMA_CACHE_DEFAULT_TTL_MS,
    cacheMaxEntries: 500,
    warnOnUnboundedReads: true,
  };
}

export class PrismaPerformanceMonitor {
  private readonly queryLogger: QueryLogger;
  private readonly cache: QueryCache;
  private readonly options: Required<PrismaPerformanceOptions>;
  private readonly operations = new Map<string, PrismaOperationStats>();
  private readonly lastUnboundedWarn = new Map<string, number>();
  private unboundedReads = 0;
  private client: PrismaClient | null = null;

  constructor(options: PrismaPerformanceOptions = {}) {
    this.options = { ...defaultPrismaPerformanceOptions(), ...options };
    this.queryLogger = new QueryLogger({
      slowQueryThresholdMs: this.options.slowQueryThresholdMs,
      logQueries: this.options.logQueries,
    });
    this.cache = new QueryCache({
      defaultTtlMs: Math.min(this.options.cacheTtlMs, PRISMA_CACHE_MAX_TTL_MS),
      maxEntries: this.options.cacheMaxEntries,
      maxTtlMs: PRISMA_CACHE_MAX_TTL_MS,
    });
  }

  get slowQueryThresholdMs(): number {
    return this.options.slowQueryThresholdMs;
  }

  get isCacheEnabled(): boolean {
    return this.options.cacheEnabled;
  }

  /**
   * Returns a Prisma client wrapped in a query extension that records
   * duration metrics, flags slow queries, caches safe read operations, and
   * invalidates the affected cache tags on writes.
   */
  instrument(client: PrismaClient): PrismaClient {
    this.client = client;
    const handleOperation = this.handleOperation.bind(this);

    return client.$extends({
      name: 'query-performance',
      query: {
        $allModels: {
          $allOperations: (context: {
            model: string;
            operation: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }) => handleOperation(context),
        },
      },
    }) as unknown as PrismaClient;
  }

  private async handleOperation(context: {
    model: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }): Promise<unknown> {
    const { model, operation } = context;
    const queryArgs = (context.args ?? {}) as Record<string, unknown>;
    const run = context.query as () => Promise<unknown>;
    const key = `${model}.${operation}`;
    const isWrite = WRITE_OPERATIONS.has(operation);
    const isRead = READ_OPERATIONS.has(operation);

    if (isRead && operation === 'findMany' && queryArgs.take === undefined) {
      this.recordUnboundedRead(model, operation);
    }

    if (this.options.cacheEnabled && isRead && !selectsSensitiveFields(queryArgs)) {
      const cacheKey = this.cache.generateKey(key, queryArgs);
      const tag = `model:${model}`;
      const peeked = this.cache.peek(cacheKey);

      if (peeked.hit) {
        this.recordCacheHit(key);
        return peeked.value;
      }

      return this.cache.getOrLoad(
        cacheKey,
        async () => {
          this.recordCacheMiss(key);
          return this.execute(key, model, operation, queryArgs, run);
        },
        this.cacheTtl,
        [tag],
        false
      );
    }

    try {
      return await this.execute(key, model, operation, queryArgs, run);
    } finally {
      if (isWrite) {
        const invalidated = this.cache.invalidateTags([`model:${model}`]);
        if (invalidated > 0) {
          logger.debug({ model, invalidated }, 'Invalidated cached reads after write');
        }
      }
    }
  }

  private cacheOptionsTtl(): number {
    return this.options.cacheTtlMs;
  }

  get cacheTtl(): number {
    return Math.min(this.options.cacheTtlMs, PRISMA_CACHE_MAX_TTL_MS);
  }

  private async execute(
    key: string,
    model: string,
    operation: string,
    args: Record<string, unknown>,
    run: () => Promise<unknown>
  ): Promise<unknown> {
    const start = process.hrtime.bigint();
    let result: unknown;
    let status: 'success' | 'error' = 'success';

    try {
      result = await run();
      return result;
    } catch (error) {
      status = 'error';
      this.recordStats(key, model, operation, 0, true, 0);
      this.queryLogger.logQuery({
        queryName: normalizeQueryName(key),
        operation: key,
        fingerprint: key,
        params: args,
        durationMs: this.elapsedMs(start),
        error,
      });
      throw error;
    } finally {
      if (status === 'success') {
        const durationMs = this.elapsedMs(start);
        const rows = countRows(result);
        this.recordStats(key, model, operation, durationMs, false, rows);

        prismaQueryDuration.observe(
          { model, operation, status, source: 'prisma' },
          durationMs / 1000
        );
        prismaQueryCount.inc({ model, operation, status, source: 'prisma' });
        prismaQueryRows.observe({ model, operation }, rows);

        if (durationMs >= this.options.slowQueryThresholdMs) {
          prismaSlowQueriesCounter.inc({ model, operation });
        }

        this.queryLogger.logQuery({
          queryName: normalizeQueryName(key),
          operation: key,
          fingerprint: key,
          params: args,
          durationMs,
          rowCount: rows,
        });
      }
    }
  }

  private elapsedMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  private recordStats(
    key: string,
    model: string,
    operation: string,
    durationMs: number,
    isError: boolean,
    rows: number
  ): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };

    existing.count += 1;
    if (isError) {
      existing.errors += 1;
    } else {
      existing.totalDurationMs += durationMs;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.rows += rows;
      if (durationMs >= this.options.slowQueryThresholdMs) {
        existing.slowQueries += 1;
      }
    }

    this.operations.set(key, existing);
  }

  private recordCacheMiss(key: string): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };
    existing.cacheMisses += 1;
    this.operations.set(key, existing);
    prismaCacheMissesCounter.inc({
      model: key.split('.')[0] ?? 'unknown',
      operation: key.split('.')[1] ?? key,
    });
  }

  private recordCacheHit(key: string): void {
    const existing = this.operations.get(key) ?? {
      count: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowQueries: 0,
      rows: 0,
    };
    existing.cacheHits += 1;
    this.operations.set(key, existing);
    prismaCacheHitsCounter.inc({
      model: key.split('.')[0] ?? 'unknown',
      operation: key.split('.')[1] ?? key,
    });
  }

  private recordUnboundedRead(model: string, operation: string): void {
    this.unboundedReads += 1;
    prismaUnboundedReadsCounter.inc({ model, operation });

    if (!this.options.warnOnUnboundedReads) return;

    const key = `${model}.${operation}`;
    const now = Date.now();
    const last = this.lastUnboundedWarn.get(key) ?? 0;
    if (now - last < UNBOUNDED_READ_WARN_INTERVAL_MS) return;
    this.lastUnboundedWarn.set(key, now);

    logger.warn(
      { model, operation },
      `Unbounded read detected on ${key} (no "take"). Add pagination (take/skip or cursor) to keep result sets bounded.`
    );
  }

  /** Invalidate cached reads, optionally limited to a single model's tag. */
  invalidateCache(model?: string): number {
    if (model) {
      return this.cache.invalidateTags([`model:${model}`]);
    }
    const size = this.cache.getStats().size;
    this.cache.clear();
    dbCacheSizeGauge.set(0);
    return size;
  }

  getSlowQueries() {
    return this.queryLogger.getSlowQueries();
  }

  getQueryLogger(): QueryLogger {
    return this.queryLogger;
  }

  getCache(): QueryCache {
    return this.cache;
  }

  getClient(): PrismaClient | null {
    return this.client;
  }

  getStats(): PrismaPerformanceStats {
    const operations: Record<string, PrismaOperationStats> = {};
    let totalQueries = 0;
    let totalErrors = 0;
    let slowQueries = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let totalDurationMs = 0;
    let maxDurationMs = 0;

    for (const [key, value] of this.operations.entries()) {
      operations[key] = { ...value };
      totalQueries += value.count;
      totalErrors += value.errors;
      slowQueries += value.slowQueries;
      cacheHits += value.cacheHits;
      cacheMisses += value.cacheMisses;
      totalDurationMs += value.totalDurationMs;
      maxDurationMs = Math.max(maxDurationMs, value.maxDurationMs);
    }

    const cacheStats = this.cache.getStats();
    dbCacheSizeGauge.set(cacheStats.size);

    return {
      totalQueries,
      totalErrors,
      slowQueries,
      cacheHits,
      cacheMisses,
      unboundedReads: this.unboundedReads,
      totalDurationMs: Math.round(totalDurationMs * 100) / 100,
      maxDurationMs: Math.round(maxDurationMs * 100) / 100,
      operations,
      cache: {
        entries: cacheStats.size,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
        hitRate: cacheStats.hitRate,
        evictions: cacheStats.evictions,
      },
    };
  }

  resetStats(): void {
    this.operations.clear();
    this.lastUnboundedWarn.clear();
    this.unboundedReads = 0;
    this.cache.resetStats();
    this.queryLogger.resetSlowQueries();
  }
}

let sharedMonitor: PrismaPerformanceMonitor | null = null;

export function getPrismaPerformanceMonitor(): PrismaPerformanceMonitor {
  if (!sharedMonitor) {
    sharedMonitor = new PrismaPerformanceMonitor();
  }
  return sharedMonitor;
}

export function setPrismaPerformanceMonitor(monitor: PrismaPerformanceMonitor | null): void {
  sharedMonitor = monitor;
}

/**
 * Creates a Prisma client with query performance instrumentation enabled.
 * The returned value is a regular `PrismaClient`, so it can be injected into
 * existing services without changes.
 */
export function createInstrumentedPrismaClient(
  options: PrismaPerformanceOptions = {}
): { client: PrismaClient; monitor: PrismaPerformanceMonitor } {
  const monitor = new PrismaPerformanceMonitor(options);
  const baseClient = new PrismaClient();
  const client = monitor.instrument(baseClient);
  setPrismaPerformanceMonitor(monitor);
  return { client, monitor };
}

/** Test seam: builds a cache key for a Prisma operation without a client. */
export function buildPrismaCacheKey(model: string, operation: string, args: unknown): string {
  return `${model}.${operation}:${stableStringify(args)}`;
}

export const __testing = { selectsSensitiveFields, countRows, stableStringify, isPlainObject };

export type { Prisma };
