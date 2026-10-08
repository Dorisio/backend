/**
 * In-process request metrics store (#54).
 *
 * Every API request is recorded once (method, route, status, duration, user and
 * client address) and aggregated on read into the shapes an operator asks for:
 * p50/p95/p99 latency, per-endpoint success/error rates, request volume over
 * time, which users call what, and the slowest endpoints. Alert thresholds are
 * derived from the same window, so a dashboard and an alert can never disagree.
 *
 * Observations are kept in a bounded, time-windowed buffer: everything older
 * than the retention window (30 days by default) is pruned, which keeps memory
 * flat without a database round-trip on the request path. The Prometheus
 * histograms in lib/metrics.ts remain the long-term store; `snapshot()` is what
 * the JSON dashboard endpoints and the anomaly checks read.
 */

export interface RequestObservation {
  method: string;
  /** Normalized route pattern (e.g. `/api/v1/transactions/:id`), not the raw URL. */
  route: string;
  statusCode: number;
  durationMs: number;
  userId?: string;
  ip?: string;
  timestamp?: Date;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
}

export interface RouteMetrics extends LatencySummary {
  route: string;
  method: string;
  requests: number;
  errors: number;
  errorRate: number;
}

export interface VolumeBucket {
  bucket: string;
  requests: number;
  errors: number;
}

export interface RequestAlert {
  type: 'error_rate' | 'p99_latency' | 'traffic_spike';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
}

export interface RequestMetricsSnapshot {
  windowMs: number;
  generatedAt: string;
  totals: {
    requests: number;
    errors: number;
    errorRate: number;
    distinctRoutes: number;
    distinctUsers: number;
  };
  latency: LatencySummary;
  byRoute: RouteMetrics[];
  topSlowRoutes: RouteMetrics[];
  topUsers: Array<{ userId: string; requests: number; errors: number }>;
  volume: VolumeBucket[];
  alerts: RequestAlert[];
}

export interface RequestMetricsOptions {
  /** How long observations are kept. Defaults to 30 days. */
  retentionMs?: number;
  /** Error-rate (0-1) above which an alert is raised. */
  errorRateThreshold?: number;
  /** p99 latency (ms) above which an alert is raised. */
  p99LatencyThresholdMs?: number;
  /** Minimum requests in the window before error-rate/latency alerts fire. */
  minRequestsForAlert?: number;
  /** Recent/minutes-baseline volume ratio that counts as a spike. */
  trafficSpikeRatio?: number;
  /** Hard cap on buffered observations (defence against unbounded growth). */
  maxObservations?: number;
  /** Injectable clock so retention and volume buckets are testable. */
  now?: () => number;
}

const DEFAULTS = {
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  errorRateThreshold: 0.05,
  p99LatencyThresholdMs: 5000,
  minRequestsForAlert: 20,
  trafficSpikeRatio: 3,
  maxObservations: 200_000,
};

/** Routes that must never be tracked: probes and the metrics surface itself. */
const EXCLUDED_ROUTES = ['/health', '/ready', '/live', '/metrics', '/metrics/json', '/docs', '/docs/'];

/**
 * Health checks and the metrics/scrape endpoints are high-frequency, low-value
 * noise: including them would swamp latency percentiles and error rates.
 */
export function shouldTrackRoute(route: string): boolean {
  if (!route) return false;
  const path = route.split('?')[0];
  return !EXCLUDED_ROUTES.some((excluded) => path === excluded || path.startsWith(excluded));
}

/** Nearest-rank percentile over an ascending-sorted numeric array. */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

function summarize(durations: number[]): LatencySummary {
  if (durations.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, avg: 0, max: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    avg: Math.round((total / sorted.length) * 100) / 100,
    max: sorted[sorted.length - 1],
  };
}

export class RequestMetricsStore {
  private observations: Array<Required<Omit<RequestObservation, 'timestamp'>> & { timestampMs: number }> = [];

  private options: Required<RequestMetricsOptions>;

  constructor(options: RequestMetricsOptions = {}) {
    this.options = { ...DEFAULTS, ...options } as Required<RequestMetricsOptions>;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Record one request. Out-of-scope routes are the caller's responsibility. */
  record(observation: RequestObservation): void {
    const timestampMs = observation.timestamp ? observation.timestamp.getTime() : this.now();
    this.observations.push({
      method: observation.method,
      route: observation.route,
      statusCode: observation.statusCode,
      durationMs: observation.durationMs,
      userId: observation.userId ?? '',
      ip: observation.ip ?? '',
      timestampMs,
    });

    if (this.observations.length > this.options.maxObservations) {
      this.observations.splice(0, this.observations.length - this.options.maxObservations);
    }

    this.prune();
  }

  /** Drop observations older than the retention window. */
  prune(now: number = this.now()): number {
    const cutoff = now - this.options.retentionMs;
    const before = this.observations.length;
    this.observations = this.observations.filter((observation) => observation.timestampMs >= cutoff);
    return before - this.observations.length;
  }

  reset(): void {
    this.observations = [];
  }

  size(): number {
    return this.observations.length;
  }

  private select(windowMs: number, filters: { route?: string; method?: string } = {}) {
    const cutoff = this.now() - windowMs;
    return this.observations.filter(
      (observation) =>
        observation.timestampMs >= cutoff &&
        (!filters.route || observation.route === filters.route) &&
        (!filters.method || observation.method === filters.method)
    );
  }

  /**
   * Aggregate the observations in the trailing `windowMs` into the dashboard
   * shapes. `bucketMs` controls the granularity of the volume series.
   */
  snapshot(
    windowMs: number = 60 * 60 * 1000,
    filters: { route?: string; method?: string; bucketMs?: number; topN?: number } = {}
  ): RequestMetricsSnapshot {
    const bucketMs = filters.bucketMs ?? 60 * 1000;
    const topN = filters.topN ?? 10;
    const rows = this.select(windowMs, filters);

    const durations: number[] = [];
    const byRouteKey = new Map<string, { route: string; method: string; durations: number[]; errors: number }>();
    const byUser = new Map<string, { requests: number; errors: number }>();
    const byBucket = new Map<number, { requests: number; errors: number }>();
    let errors = 0;

    for (const row of rows) {
      const isError = row.statusCode >= 500;
      durations.push(row.durationMs);
      if (isError) errors += 1;

      const key = `${row.method} ${row.route}`;
      const routeEntry = byRouteKey.get(key) ?? {
        route: row.route,
        method: row.method,
        durations: [],
        errors: 0,
      };
      routeEntry.durations.push(row.durationMs);
      if (isError) routeEntry.errors += 1;
      byRouteKey.set(key, routeEntry);

      if (row.userId) {
        const userEntry = byUser.get(row.userId) ?? { requests: 0, errors: 0 };
        userEntry.requests += 1;
        if (isError) userEntry.errors += 1;
        byUser.set(row.userId, userEntry);
      }

      const bucketStart = Math.floor(row.timestampMs / bucketMs) * bucketMs;
      const bucketEntry = byBucket.get(bucketStart) ?? { requests: 0, errors: 0 };
      bucketEntry.requests += 1;
      if (isError) bucketEntry.errors += 1;
      byBucket.set(bucketStart, bucketEntry);
    }

    const byRoute: RouteMetrics[] = [...byRouteKey.values()]
      .map((entry) => ({
        ...summarize(entry.durations),
        route: entry.route,
        method: entry.method,
        requests: entry.durations.length,
        errors: entry.errors,
        errorRate: entry.durations.length === 0 ? 0 : entry.errors / entry.durations.length,
      }))
      .sort((a, b) => b.requests - a.requests);

    const topSlowRoutes = [...byRoute]
      .filter((route) => route.requests > 0)
      .sort((a, b) => b.p99 - a.p99)
      .slice(0, topN);

    const topUsers = [...byUser.entries()]
      .map(([userId, value]) => ({ userId, ...value }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, topN);

    const volume: VolumeBucket[] = [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucketStart, value]) => ({
        bucket: new Date(bucketStart).toISOString(),
        requests: value.requests,
        errors: value.errors,
      }));

    const latency = summarize(durations);
    const errorRate = rows.length === 0 ? 0 : errors / rows.length;

    return {
      windowMs,
      generatedAt: new Date(this.now()).toISOString(),
      totals: {
        requests: rows.length,
        errors,
        errorRate,
        distinctRoutes: byRouteKey.size,
        distinctUsers: byUser.size,
      },
      latency,
      byRoute,
      topSlowRoutes,
      topUsers,
      volume,
      alerts: this.evaluateAlerts(rows.length, errorRate, latency, byBucket),
    };
  }

  /**
   * Alert rules from the issue: sustained 5xx rate, p99 latency above the
   * interactive budget, and a sudden traffic spike compared with the trailing
   * baseline. Thresholds are intentionally conservative and configurable so the
   * default deployment does not page on a single slow request.
   */
  private evaluateAlerts(
    requests: number,
    errorRate: number,
    latency: LatencySummary,
    byBucket: Map<number, { requests: number; errors: number }>
  ): RequestAlert[] {
    const alerts: RequestAlert[] = [];

    if (requests >= this.options.minRequestsForAlert) {
      if (errorRate > this.options.errorRateThreshold) {
        alerts.push({
          type: 'error_rate',
          severity: errorRate > this.options.errorRateThreshold * 2 ? 'critical' : 'warning',
          message: `5xx rate ${(errorRate * 100).toFixed(2)}% exceeds ${(this.options.errorRateThreshold * 100).toFixed(2)}%`,
          value: errorRate,
          threshold: this.options.errorRateThreshold,
        });
      }

      if (latency.p99 > this.options.p99LatencyThresholdMs) {
        alerts.push({
          type: 'p99_latency',
          severity: 'warning',
          message: `p99 latency ${latency.p99}ms exceeds ${this.options.p99LatencyThresholdMs}ms`,
          value: latency.p99,
          threshold: this.options.p99LatencyThresholdMs,
        });
      }
    }

    const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
    if (buckets.length >= 3) {
      const latest = buckets[buckets.length - 1][1].requests;
      const baselineBuckets = buckets.slice(0, -1).map(([, value]) => value.requests);
      const baseline =
        baselineBuckets.reduce((sum, value) => sum + value, 0) / baselineBuckets.length;
      if (baseline > 0 && latest > baseline * this.options.trafficSpikeRatio) {
        alerts.push({
          type: 'traffic_spike',
          severity: 'warning',
          message: `Traffic ${latest} req/min is ${(latest / baseline).toFixed(1)}x the recent average (${Math.round(baseline)})`,
          value: latest,
          threshold: baseline * this.options.trafficSpikeRatio,
        });
      }
    }

    return alerts;
  }
}

let defaultStore: RequestMetricsStore | undefined;

/** Process-wide store used by the request hook and the dashboard routes. */
export function getRequestMetricsStore(): RequestMetricsStore {
  if (!defaultStore) {
    defaultStore = new RequestMetricsStore();
  }
  return defaultStore;
}

/** Test/DI seam: replace the process-wide store. */
export function setRequestMetricsStore(store: RequestMetricsStore): void {
  defaultStore = store;
}
