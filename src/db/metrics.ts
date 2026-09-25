import { Counter, Gauge, Histogram } from 'prom-client';

// DB Connection Pool Gauges
export const dbPoolTotalConnections = new Gauge({
  name: 'dorisio_db_pool_total_connections',
  help: 'Total number of connections in the database pool',
});

export const dbPoolIdleConnections = new Gauge({
  name: 'dorisio_db_pool_idle_connections',
  help: 'Number of idle connections available in the pool',
});

export const dbPoolActiveConnections = new Gauge({
  name: 'dorisio_db_pool_active_connections',
  help: 'Number of active connections checked out from the pool',
});

export const dbPoolWaitingClients = new Gauge({
  name: 'dorisio_db_pool_waiting_clients',
  help: 'Number of queries currently waiting for a database connection',
});

// DB Counters
export const dbPoolExhaustionCounter = new Counter({
  name: 'dorisio_db_pool_exhaustion_total',
  help: 'Total occurrences of connection pool exhaustion / timeouts',
});

export const dbCircuitBreakerStateGauge = new Gauge({
  name: 'dorisio_db_circuit_breaker_state',
  help: 'Current database circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
});

export const dbCircuitBreakerTripsCounter = new Counter({
  name: 'dorisio_db_circuit_breaker_trips_total',
  help: 'Total times the database circuit breaker has tripped to OPEN',
});

export const dbSlowQueriesCounter = new Counter({
  name: 'dorisio_db_slow_queries_total',
  help: 'Total count of slow database queries exceeding threshold',
  labelNames: ['query_name'],
});

export const dbConnectionLeaksCounter = new Counter({
  name: 'dorisio_db_connection_leaks_total',
  help: 'Total count of detected unreleased connection leaks',
});

export const dbQueryErrorsCounter = new Counter({
  name: 'dorisio_db_query_errors_total',
  help: 'Total database query errors',
  labelNames: ['error_code'],
});

export const dbQueryDuration = new Histogram({
  name: 'dorisio_db_query_duration_seconds_pool',
  help: 'Database query execution duration in seconds via connection pool',
  labelNames: ['query_name', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const dbCacheHitsCounter = new Counter({
  name: 'dorisio_db_cache_hits_total',
  help: 'Total query cache hits',
});

export const dbCacheMissesCounter = new Counter({
  name: 'dorisio_db_cache_misses_total',
  help: 'Total query cache misses',
});

export const dbCacheSizeGauge = new Gauge({
  name: 'dorisio_db_query_cache_entries',
  help: 'Number of entries currently held in the query result cache',
});

export const dbCacheEvictionsCounter = new Counter({
  name: 'dorisio_db_cache_evictions_total',
  help: 'Total query cache evictions caused by capacity limits',
});

export const dbQueryCacheLatency = new Histogram({
  name: 'dorisio_db_cache_operation_duration_seconds',
  help: 'Duration of cache lookups and loads',
  labelNames: ['operation', 'result'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
});

// Prisma/ORM query instrumentation
export const prismaQueryDuration = new Histogram({
  name: 'dorisio_prisma_query_duration_seconds',
  help: 'Prisma query duration in seconds, labelled by model.operation',
  labelNames: ['model', 'operation', 'status', 'source'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const prismaQueryCount = new Counter({
  name: 'dorisio_prisma_query_total',
  help: 'Total Prisma queries executed, labelled by model.operation',
  labelNames: ['model', 'operation', 'status', 'source'],
});

export const prismaQueryRows = new Histogram({
  name: 'dorisio_prisma_query_rows',
  help: 'Rows returned per Prisma query',
  labelNames: ['model', 'operation'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 500, 1000, 5000],
});

export const prismaSlowQueriesCounter = new Counter({
  name: 'dorisio_prisma_slow_queries_total',
  help: 'Prisma queries exceeding the slow query threshold, labelled by model.operation',
  labelNames: ['model', 'operation'],
});

export const prismaCacheHitsCounter = new Counter({
  name: 'dorisio_prisma_cache_hits_total',
  help: 'Prisma queries served from the query result cache',
  labelNames: ['model', 'operation'],
});

export const prismaCacheMissesCounter = new Counter({
  name: 'dorisio_prisma_cache_misses_total',
  help: 'Prisma queries that missed the query result cache',
  labelNames: ['model', 'operation'],
});

export const prismaUnboundedReadsCounter = new Counter({
  name: 'dorisio_prisma_unbounded_reads_total',
  help: 'Prisma list reads executed without an explicit take/limit (potential unbounded result set)',
  labelNames: ['model', 'operation'],
});

export const prismaUnpaginatedReadsTotal = new Gauge({
  name: 'dorisio_prisma_unbounded_reads',
  help: 'Last observed number of unbounded Prisma list reads per process',
});
