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
