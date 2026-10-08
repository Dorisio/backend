import { describe, it, expect } from 'vitest';
import {
  RequestMetricsStore,
  percentile,
  shouldTrackRoute,
} from '../request-metrics';

const BASE = Date.UTC(2026, 8, 27, 12, 0, 0);
const MINUTE = 60_000;

const record = (
  store: RequestMetricsStore,
  overrides: Partial<{ method: string; route: string; statusCode: number; durationMs: number; userId: string; at: number }> = {}
) => {
  store.record({
    method: overrides.method ?? 'GET',
    route: overrides.route ?? '/api/v1/transactions/:id',
    statusCode: overrides.statusCode ?? 200,
    durationMs: overrides.durationMs ?? 10,
    userId: overrides.userId,
    ip: '127.0.0.1',
    timestamp: new Date(overrides.at ?? BASE),
  });
};

describe('percentile', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('uses the nearest-rank definition', () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sample, 50)).toBe(5);
    expect(percentile(sample, 95)).toBe(10);
    expect(percentile(sample, 99)).toBe(10);
  });

  it('handles a single observation', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('shouldTrackRoute', () => {
  it('excludes probes, the metrics surface and docs', () => {
    for (const route of ['/health', '/ready', '/live', '/metrics', '/metrics/json', '/docs', '/docs/']) {
      expect(shouldTrackRoute(route)).toBe(false);
    }
  });

  it('tracks real API endpoints, including ones that start with an excluded prefix', () => {
    expect(shouldTrackRoute('/api/v1/transactions/:id')).toBe(true);
    expect(shouldTrackRoute('/api/v1/health-records')).toBe(true);
    expect(shouldTrackRoute('')).toBe(false);
  });
});

describe('RequestMetricsStore aggregation', () => {
  it('aggregates totals, error rate and latency percentiles', () => {
    const store = new RequestMetricsStore({ now: () => BASE });

    for (const durationMs of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      record(store, { durationMs });
    }
    record(store, { statusCode: 500, durationMs: 250 });
    record(store, { statusCode: 503, durationMs: 300 });

    const snapshot = store.snapshot(MINUTE, { bucketMs: MINUTE });

    expect(snapshot.totals.requests).toBe(12);
    expect(snapshot.totals.errors).toBe(2);
    expect(snapshot.totals.errorRate).toBeCloseTo(2 / 12, 5);
    expect(snapshot.latency.max).toBe(300);
    expect(snapshot.latency.p50).toBeGreaterThan(0);
    expect(snapshot.latency.p99).toBe(300);
  });

  it('groups by route pattern and method, not by concrete URL', () => {
    const store = new RequestMetricsStore({ now: () => BASE });
    record(store, { route: '/api/v1/transactions/:id', method: 'GET' });
    record(store, { route: '/api/v1/transactions/:id', method: 'GET' });
    record(store, { route: '/api/v1/transactions/:id', method: 'DELETE', statusCode: 500 });

    const snapshot = store.snapshot(MINUTE);

    const get = snapshot.byRoute.find((route) => route.method === 'GET');
    const del = snapshot.byRoute.find((route) => route.method === 'DELETE');

    expect(get).toMatchObject({ requests: 2, errors: 0, errorRate: 0 });
    expect(del).toMatchObject({ requests: 1, errors: 1, errorRate: 1 });
    expect(snapshot.totals.distinctRoutes).toBe(2);
  });

  it('tracks the busiest users and their error counts', () => {
    const store = new RequestMetricsStore({ now: () => BASE });
    record(store, { userId: 'user_a' });
    record(store, { userId: 'user_a' });
    record(store, { userId: 'user_a', statusCode: 500 });
    record(store, { userId: 'user_b' });

    const snapshot = store.snapshot(MINUTE);

    expect(snapshot.totals.distinctUsers).toBe(2);
    expect(snapshot.topUsers[0]).toEqual({ userId: 'user_a', requests: 3, errors: 1 });
    expect(snapshot.topUsers[1]).toEqual({ userId: 'user_b', requests: 1, errors: 0 });
  });

  it('buckets request volume over time', () => {
    const store = new RequestMetricsStore({ now: () => BASE + 3 * MINUTE });
    record(store, { at: BASE });
    record(store, { at: BASE + 30_000 });
    record(store, { at: BASE + 2 * MINUTE });

    const snapshot = store.snapshot(10 * MINUTE, { bucketMs: MINUTE });

    expect(snapshot.volume).toEqual([
      { bucket: new Date(BASE).toISOString(), requests: 2, errors: 0 },
      { bucket: new Date(BASE + 2 * MINUTE).toISOString(), requests: 1, errors: 0 },
    ]);
  });

  it('filters by route and method', () => {
    const store = new RequestMetricsStore({ now: () => BASE });
    record(store, { route: '/a', method: 'GET' });
    record(store, { route: '/b', method: 'POST' });

    expect(store.snapshot(MINUTE, { route: '/a' }).totals.requests).toBe(1);
    expect(store.snapshot(MINUTE, { method: 'POST' }).totals.requests).toBe(1);
    expect(store.snapshot(MINUTE, { route: '/a', method: 'POST' }).totals.requests).toBe(0);
  });

  it('ignores observations outside the requested window', () => {
    const store = new RequestMetricsStore({ now: () => BASE + 10 * MINUTE });
    record(store, { at: BASE });
    record(store, { at: BASE + 9 * MINUTE });

    expect(store.snapshot(MINUTE).totals.requests).toBe(1);
  });

  it('ranks the slowest endpoints by p99', () => {
    const store = new RequestMetricsStore({ now: () => BASE });
    record(store, { route: '/fast', durationMs: 5 });
    record(store, { route: '/slow', durationMs: 900 });
    record(store, { route: '/slow', durationMs: 950 });

    expect(store.snapshot(MINUTE).topSlowRoutes[0].route).toBe('/slow');
  });
});

describe('RequestMetricsStore retention', () => {
  it('prunes observations older than the retention window', () => {
    let clock = BASE;
    const store = new RequestMetricsStore({ retentionMs: 1000, now: () => clock });

    record(store, { at: BASE });
    expect(store.size()).toBe(1);

    clock = BASE + 5000;
    record(store, { at: BASE + 5000 });

    // The first observation aged out; the second replaced it.
    expect(store.size()).toBe(1);
  });

  it('caps the buffered observation count', () => {
    const store = new RequestMetricsStore({ maxObservations: 5, now: () => BASE });
    for (let i = 0; i < 20; i += 1) {
      record(store, { durationMs: i });
    }
    expect(store.size()).toBe(5);
    // The newest observations are the ones kept.
    expect(store.snapshot(MINUTE).latency.max).toBe(19);
  });
});

describe('RequestMetricsStore alerts', () => {
  const alertStore = (overrides = {}) =>
    new RequestMetricsStore({
      now: () => BASE + MINUTE,
      minRequestsForAlert: 5,
      errorRateThreshold: 0.1,
      p99LatencyThresholdMs: 500,
      trafficSpikeRatio: 3,
      ...overrides,
    });

  it('raises an error-rate alert and escalates it when twice the threshold', () => {
    const store = alertStore();
    for (let i = 0; i < 6; i += 1) record(store, { statusCode: i < 3 ? 500 : 200 });

    const [alert] = store.snapshot(MINUTE).alerts.filter((a) => a.type === 'error_rate');
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('critical');
    expect(alert.value).toBeCloseTo(0.5, 5);
  });

  it('does not raise alerts below the minimum request count', () => {
    const store = alertStore();
    record(store, { statusCode: 500 });
    record(store, { statusCode: 500 });
    expect(store.snapshot(MINUTE).alerts).toEqual([]);
  });

  it('raises a p99 latency alert', () => {
    const store = alertStore();
    for (let i = 0; i < 6; i += 1) record(store, { durationMs: 10 });
    record(store, { durationMs: 2000 });

    const [alert] = store.snapshot(MINUTE).alerts.filter((a) => a.type === 'p99_latency');
    expect(alert).toBeDefined();
    expect(alert.value).toBe(2000);
  });

  it('raises a traffic-spike alert against the trailing baseline', () => {
    const store = alertStore({ minRequestsForAlert: 1000 });
    for (let minute = 0; minute < 3; minute += 1) {
      record(store, { at: BASE + minute * MINUTE });
    }
    for (let i = 0; i < 10; i += 1) {
      record(store, { at: BASE + 3 * MINUTE });
    }

    const [alert] = store.snapshot(10 * MINUTE, { bucketMs: MINUTE }).alerts.filter(
      (a) => a.type === 'traffic_spike'
    );
    expect(alert).toBeDefined();
    expect(alert.value).toBe(10);
  });

  it('reports no alerts for healthy traffic', () => {
    const store = alertStore();
    for (let i = 0; i < 10; i += 1) record(store, { durationMs: 20 });
    expect(store.snapshot(MINUTE).alerts).toEqual([]);
  });
});
