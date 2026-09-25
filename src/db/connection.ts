import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  DatabaseCircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerMetrics,
} from './circuit-breaker';
import { QueryLogger, QueryLogOptions } from './query-logger';
import { QueryCache } from './query-cache';
import { PreparedStatementConfig } from './query-optimizer';
import {
  dbPoolTotalConnections,
  dbPoolIdleConnections,
  dbPoolActiveConnections,
  dbPoolWaitingClients,
  dbPoolExhaustionCounter,
  dbCircuitBreakerStateGauge,
  dbCircuitBreakerTripsCounter,
  dbSlowQueriesCounter,
  dbConnectionLeaksCounter,
  dbQueryDuration,
  dbQueryErrorsCounter,
  dbCacheHitsCounter,
  dbCacheMissesCounter,
} from './metrics';

export interface DatabasePoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  activeCount: number;
}

export interface DatabaseHealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  circuitBreaker: CircuitBreakerMetrics;
  pool: DatabasePoolMetrics;
  error?: string;
}

export interface QueryOptions {
  queryName?: string;
  useCache?: boolean;
  cacheTtlMs?: number;
  cacheTags?: string[];
  bypassCircuitBreaker?: boolean;
}

export interface CustomDatabaseConfig {
  connectionString?: string;
  min?: number;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMs?: number;
  slowQueryThresholdMs?: number;
  logQueries?: boolean;
  leakDetectionTimeoutMs?: number;
  circuitBreakerFailures?: number;
  circuitBreakerResetMs?: number;
}

interface ActiveCheckout {
  client: PoolClient;
  acquiredAt: number;
  stack?: string;
  leakTimeoutId?: ReturnType<typeof setTimeout>;
}

let pool: Pool | null = null;
let circuitBreaker: DatabaseCircuitBreaker | null = null;
let queryLogger: QueryLogger | null = null;
let queryCache: QueryCache | null = null;

const activeCheckouts = new Map<PoolClient, ActiveCheckout>();
let leakDetectionTimeoutMs = 30000;

function updateCircuitBreakerMetric(state: CircuitBreakerState): void {
  const stateVal = state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2;
  dbCircuitBreakerStateGauge.set(stateVal);
}

export const getPoolMetrics = (): DatabasePoolMetrics => {
  if (!pool) {
    return {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      activeCount: 0,
    };
  }

  const totalCount = pool.totalCount;
  const idleCount = pool.idleCount;
  const waitingCount = pool.waitingCount;
  const activeCount = Math.max(0, totalCount - idleCount);

  // Sync with Prometheus gauges
  dbPoolTotalConnections.set(totalCount);
  dbPoolIdleConnections.set(idleCount);
  dbPoolWaitingClients.set(waitingCount);
  dbPoolActiveConnections.set(activeCount);

  return {
    totalCount,
    idleCount,
    waitingCount,
    activeCount,
  };
};

export const initializeDatabase = async (
  customConfig: CustomDatabaseConfig = {}
): Promise<Pool> => {
  if (pool) {
    logger.warn('Database pool already initialized');
    return pool;
  }

  const poolMin = customConfig.min ?? config.DB_POOL_MIN ?? 2;
  const poolMax = customConfig.max ?? config.DB_POOL_MAX ?? 20;
  const connectionTimeout =
    customConfig.connectionTimeoutMillis ?? config.DB_CONNECTION_TIMEOUT_MS ?? 5000;
  const idleTimeout =
    customConfig.idleTimeoutMillis ?? config.DB_IDLE_TIMEOUT_MS ?? 30000;
  const statementTimeout =
    customConfig.statementTimeoutMs ?? config.DB_STATEMENT_TIMEOUT_MS ?? 10000;
  const slowThreshold =
    customConfig.slowQueryThresholdMs ?? config.DB_SLOW_QUERY_THRESHOLD_MS ?? 200;
  const logQueries =
    customConfig.logQueries ?? config.DB_LOG_QUERIES ?? false;
  leakDetectionTimeoutMs =
    customConfig.leakDetectionTimeoutMs ?? config.DB_LEAK_DETECTION_TIMEOUT_MS ?? 30000;
  const cbFailures =
    customConfig.circuitBreakerFailures ?? config.DB_CIRCUIT_BREAKER_FAILURES ?? 5;
  const cbResetMs =
    customConfig.circuitBreakerResetMs ?? config.DB_CIRCUIT_BREAKER_RESET_MS ?? 10000;

  circuitBreaker = new DatabaseCircuitBreaker({
    name: 'pg-main-pool',
    failureThreshold: cbFailures,
    resetTimeoutMs: cbResetMs,
    onStateChange: (from, to) => {
      updateCircuitBreakerMetric(to);
      if (to === 'OPEN') {
        dbCircuitBreakerTripsCounter.inc();
      }
    },
  });
  updateCircuitBreakerMetric(circuitBreaker.getState());

  queryLogger = new QueryLogger({
    slowQueryThresholdMs: slowThreshold,
    logQueries,
  });

  queryCache = new QueryCache();

  const poolConfig: PoolConfig = {
    connectionString: customConfig.connectionString ?? config.DATABASE_URL,
    min: poolMin,
    max: poolMax,
    idleTimeoutMillis: idleTimeout,
    connectionTimeoutMillis: connectionTimeout,
    statement_timeout: statementTimeout,
  };

  try {
    pool = new Pool(poolConfig);

    // Event listeners on pool
    pool.on('error', (err: Error, client: PoolClient) => {
      logger.error({ err }, 'Unexpected error on idle database client');
      dbQueryErrorsCounter.inc({ error_code: 'IDLE_CLIENT_ERROR' });
      // Client is automatically discarded by pg.Pool upon error event
    });

    pool.on('connect', (_client: PoolClient) => {
      getPoolMetrics();
    });

    pool.on('acquire', (client: PoolClient) => {
      trackClientAcquisition(client);
      getPoolMetrics();
    });

    pool.on('release', (_err: Error | undefined, client: PoolClient) => {
      trackClientRelease(client);
      getPoolMetrics();
    });

    pool.on('remove', (_client: PoolClient) => {
      getPoolMetrics();
    });

    // Test initial connection
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      logger.info(
        {
          min: poolMin,
          max: poolMax,
          idleTimeoutMs: idleTimeout,
          connectionTimeoutMs: connectionTimeout,
        },
        'Database connection pool initialized successfully'
      );
    } finally {
      client.release();
    }

    return pool;
  } catch (error) {
    if (circuitBreaker) {
      circuitBreaker.recordFailure(error);
    }
    dbPoolExhaustionCounter.inc();
    logger.error({ error }, 'Failed to initialize database pool');
    throw error;
  }
};

function trackClientAcquisition(client: PoolClient): void {
  const stack = new Error().stack;
  const acquiredAt = Date.now();

  const leakTimeoutId = setTimeout(() => {
    logger.warn(
      {
        heldDurationMs: Date.now() - acquiredAt,
        thresholdMs: leakDetectionTimeoutMs,
        stack,
      },
      'Possible database connection leak detected! Client has been checked out for too long.'
    );
    dbConnectionLeaksCounter.inc();
  }, leakDetectionTimeoutMs);

  activeCheckouts.set(client, {
    client,
    acquiredAt,
    stack,
    leakTimeoutId,
  });
}

function trackClientRelease(client: PoolClient): void {
  const checkout = activeCheckouts.get(client);
  if (checkout) {
    if (checkout.leakTimeoutId) {
      clearTimeout(checkout.leakTimeoutId);
    }
    activeCheckouts.delete(client);
  }
}

export const getDatabase = (): Pool => {
  if (!pool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return pool;
};

export const getCircuitBreaker = (): DatabaseCircuitBreaker => {
  if (!circuitBreaker) {
    circuitBreaker = new DatabaseCircuitBreaker();
  }
  return circuitBreaker;
};

export const getQueryCache = (): QueryCache => {
  if (!queryCache) {
    queryCache = new QueryCache();
  }
  return queryCache;
};

export const getQueryLogger = (): QueryLogger => {
  if (!queryLogger) {
    queryLogger = new QueryLogger();
  }
  return queryLogger;
};

/**
 * Execute a query with connection pooling, circuit breaker, timing, metrics, and slow query logging.
 */
export const query = async <R extends QueryResultRow = any>(
  textOrConfig: string | PreparedStatementConfig,
  params?: unknown[],
  options: QueryOptions = {}
): Promise<QueryResult<R>> => {
  const currentPool = getDatabase();
  const cb = getCircuitBreaker();
  const qLogger = getQueryLogger();
  const qCache = getQueryCache();

  const isPreparedStatement = typeof textOrConfig !== 'string';
  const sql = isPreparedStatement ? textOrConfig.text : textOrConfig;
  const queryParams = isPreparedStatement ? textOrConfig.values ?? params : params;
  const queryName = options.queryName ?? (isPreparedStatement ? textOrConfig.name : undefined);

  // Check cache if requested
  if (options.useCache) {
    const cacheKey = qCache.generateKey(sql, queryParams);
    const cached = qCache.get<QueryResult<R>>(cacheKey);
    if (cached) {
      dbCacheHitsCounter.inc();
      return cached;
    }
    dbCacheMissesCounter.inc();
  }

  const startTime = Date.now();
  let result: QueryResult<R>;

  const executeAction = async (): Promise<QueryResult<R>> => {
    if (isPreparedStatement) {
      return currentPool.query<R>({
        name: textOrConfig.name,
        text: textOrConfig.text,
        values: queryParams,
      });
    }
    return currentPool.query<R>(sql, queryParams);
  };

  try {
    if (options.bypassCircuitBreaker) {
      result = await executeAction();
    } else {
      result = await cb.execute(executeAction);
    }

    const durationMs = Date.now() - startTime;
    const durationSec = durationMs / 1000;

    dbQueryDuration.observe(
      { query_name: queryName ?? 'unnamed', status: 'success' },
      durationSec
    );

    if (durationMs >= (config.DB_SLOW_QUERY_THRESHOLD_MS ?? 200)) {
      dbSlowQueriesCounter.inc({ query_name: queryName ?? 'unnamed' });
    }

    qLogger.logQuery({
      queryName,
      sql,
      params: queryParams,
      durationMs,
      rowCount: result.rowCount,
    });

    // Populate cache if enabled
    if (options.useCache) {
      const cacheKey = qCache.generateKey(sql, queryParams);
      qCache.set(cacheKey, result, options.cacheTtlMs, options.cacheTags);
    }

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const durationSec = durationMs / 1000;

    dbQueryDuration.observe(
      { query_name: queryName ?? 'unnamed', status: 'error' },
      durationSec
    );
    dbQueryErrorsCounter.inc({ error_code: error.code || 'UNKNOWN_ERROR' });

    qLogger.logQuery({
      queryName,
      sql,
      params: queryParams,
      durationMs,
      error,
    });

    throw error;
  }
};

/**
 * Execute a query with cache support
 */
export const cachedQuery = async <R extends QueryResultRow = any>(
  sql: string,
  params?: unknown[],
  options: Omit<QueryOptions, 'useCache'> = {}
): Promise<QueryResult<R>> => {
  return query<R>(sql, params, { ...options, useCache: true });
};

/**
 * Execute a prepared statement
 */
export const executePreparedStatement = async <R extends QueryResultRow = any>(
  ps: PreparedStatementConfig,
  options: QueryOptions = {}
): Promise<QueryResult<R>> => {
  return query<R>(ps, ps.values, options);
};

/**
 * Checkout a client from the pool with automatic release guarantee in finally.
 */
export const withClient = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const currentPool = getDatabase();
  const client = await currentPool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
};

/**
 * Execute a transaction within a pooled client with automatic BEGIN/COMMIT/ROLLBACK.
 */
export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>,
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
): Promise<T> => {
  return withClient(async (client) => {
    const beginSql = isolationLevel
      ? `BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel}`
      : 'BEGIN';

    await client.query(beginSql);
    try {
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ rollbackErr }, 'Failed to rollback transaction');
      }
      throw error;
    }
  });
};

/**
 * Perform comprehensive database health check including pool utilization, latency, and circuit breaker.
 */
export const checkDatabaseHealth = async (): Promise<DatabaseHealthResult> => {
  const cb = getCircuitBreaker();
  const poolMetrics = getPoolMetrics();
  const cbMetrics = cb.getMetrics();

  if (!pool) {
    return {
      status: 'unhealthy',
      latencyMs: -1,
      circuitBreaker: cbMetrics,
      pool: poolMetrics,
      error: 'Database pool not initialized',
    };
  }

  if (cb.getState() === 'OPEN') {
    return {
      status: 'unhealthy',
      latencyMs: -1,
      circuitBreaker: cbMetrics,
      pool: poolMetrics,
      error: 'Circuit breaker is OPEN',
    };
  }

  const startTime = Date.now();
  try {
    await query('SELECT 1 AS health_check', [], {
      queryName: 'health_check',
      bypassCircuitBreaker: false,
    });
    const latencyMs = Date.now() - startTime;
    const isDegraded = latencyMs > 500 || cb.getState() === 'HALF_OPEN';

    return {
      status: isDegraded ? 'degraded' : 'healthy',
      latencyMs,
      circuitBreaker: cb.getMetrics(),
      pool: poolMetrics,
    };
  } catch (error: any) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startTime,
      circuitBreaker: cb.getMetrics(),
      pool: poolMetrics,
      error: error?.message || 'Database ping failed',
    };
  }
};

/**
 * Gracefully close the database pool and clean up all resources.
 */
export const closeDatabase = async (): Promise<void> => {
  // Clear any active checkout timers
  for (const [, checkout] of activeCheckouts.entries()) {
    if (checkout.leakTimeoutId) {
      clearTimeout(checkout.leakTimeoutId);
    }
  }
  activeCheckouts.clear();

  if (queryCache) {
    queryCache.clear();
  }

  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database connection pool closed');
  }

  if (circuitBreaker) {
    circuitBreaker.reset();
  }

  getPoolMetrics();
};
