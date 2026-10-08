# Application Performance Monitoring

The backend exposes sampled request traces through the existing Prometheus endpoint. Set:

- `APM_ENABLED=false` to disable instrumentation.
- `APM_SAMPLE_RATE=0.10` through `0.50` for production sampling.
- `APM_SLOW_ENDPOINT_MS=1000` to flag slow endpoints.
- `APM_SLOW_EXTERNAL_CALL_MS=1000` to flag slow external calls.

Metrics include:

- `dorisio_apm_request_duration_seconds`: endpoint latency histogram grouped by method, route, and status.
- `dorisio_apm_errors_total`: client/server errors grouped by endpoint and type.
- `dorisio_apm_slow_requests_total`: slow endpoint and external-call count.
- `dorisio_apm_memory_heap_used_bytes`: Node.js heap usage.
- Existing Prisma instrumentation provides `dorisio_db_query_duration_seconds` and slow-query counters.

Suggested Prometheus alerts:

```yaml
- alert: DorisioHighP99Latency
  expr: histogram_quantile(0.99, sum by (le, route) (rate(dorisio_apm_request_duration_seconds_bucket[5m]))) > 1
  for: 10m

- alert: DorisioHighErrorRate
  expr: sum(rate(dorisio_apm_errors_total{type="server"}[5m])) / sum(rate(dorisio_apm_request_duration_seconds_count[5m])) > 0.01
  for: 10m
```

A dashboard should chart the p50/p95/p99 request histogram, top `route` values for `dorisio_apm_slow_requests_total`, server error rate, database query latency, and heap usage.
