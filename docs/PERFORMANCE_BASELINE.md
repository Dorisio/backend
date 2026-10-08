# Load-testing baseline

The backend includes a dependency-free load-test runner at
`scripts/load-test.ts`. It uses the same HTTP endpoint a load balancer probes,
so it measures the complete server path rather than an isolated handler.

Run it against a locally started server:

```bash
LOAD_TEST_URL=http://127.0.0.1:3000/health \
LOAD_TEST_DURATION_MS=10000 \
LOAD_TEST_CONCURRENCY=100,1000,10000 \
pnpm load-test
```

Each JSON line reports request count, failures, throughput, and p50/p95/p99
latency. Use `LOAD_TEST_OUTPUT=artifacts/load-test.json` to save a machine-
readable report for comparison between commits. The 100/1,000/10,000 levels
are deliberately explicit: a deployment must record the result at each level,
not silently stop at the first error.

The `performance.yml` workflow runs the same suite on demand against a
deployed environment. Set its URL and duration to match the environment's
safe test window; never point it at production without an approved test plan.
Teams should retain the JSON artifact as the baseline and investigate any
increase in p95 or p99 latency, error rate, or reduction in throughput.
