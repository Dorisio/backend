# Background Jobs

Long-running work — sending email, processing images, aggregating analytics and
polling Stellar for confirmations — runs on BullMQ (Redis) queues instead of
blocking API responses.

## Architecture

```
route/service ──enqueue──▶ JobService ──▶ JobQueue (BullMQ)
                                             │
                                       Worker (processor)
                                             │
                        completed / failed / exhausted ──▶ metrics + events
                                             │
                                    exhausted ──▶ dead letter queue
```

- `src/lib/jobs/types.ts` — shared types and the `JobQueue` adapter interface.
- `src/lib/jobs/bull-queue.ts` — BullMQ/Redis implementation (connections are lazy).
- `src/lib/jobs/memory-queue.ts` — in-memory implementation used by tests/local dev.
- `src/lib/jobs/service.ts` — `JobService` facade (enqueue, status, cancel, depth, DLQ).
- `src/lib/jobs/worker.ts` — worker factory wiring metrics, events and dead letters.
- `src/lib/jobs/scheduler.ts` — cron/interval repeatable jobs.
- `src/lib/jobs/processors.ts` — email, image, analytics and Stellar processors.
- `src/lib/circuit-breaker.ts` — fail-fast guard for external providers.

## Enqueuing with priority

```ts
await jobService.enqueue('email', 'email.send', { to, subject, body }, {
  priority: 'high',            // critical | high | normal | low (lower number = sooner)
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  jobId: `welcome:${userId}`,  // idempotent: re-enqueuing the same id is a no-op
});
```

## Scheduling (cron-like)

```ts
await jobService.schedule('analytics', 'analytics.aggregate', payload, {
  cron: CRON_PRESETS.analyticsRollup, // '0 2 * * *'
  priority: 'low',
});
```

## Status, cancellation and monitoring

```ts
const status = await jobService.getStatus('email', jobId); // state, progress, attempts
await jobService.cancel('email', jobId);                   // only before it starts
const depth = await jobService.getQueueDepth('email');     // per-state counts
```

Queue depth, throughput, retries and job latency are exported as Prometheus
metrics (`/metrics`):

| Metric                        | Type      | Labels                  |
| ----------------------------- | --------- | ----------------------- |
| `dorisio_jobs_enqueued_total` | counter   | queue, name, priority   |
| `dorisio_jobs_processed_total`| counter   | queue, name, status     |
| `dorisio_job_duration_seconds`| histogram | queue, name             |
| `dorisio_job_retries_total`   | counter   | queue, name             |
| `dorisio_queue_depth`         | gauge     | queue, state            |
| `dorisio_dead_letter_jobs`    | gauge     | queue                   |

## Retries and the dead letter queue

Failed jobs retry with exponential backoff (`src/lib/jobs/retry.ts`). Once a job
has exhausted its attempts it is copied to `<queue>-dlq` with the original
payload, failure reason and attempt count, then can be inspected and replayed:

```ts
const dead = await jobService.getDeadLetterJobs();
await jobService.retryDeadLetter(dead[0].id, 'email');
```

## Events

`jobEvents` (an instance of `JobEventBus`) emits `enqueued`, `active`,
`completed`, `failed`, `progress` and `dead-letter` events. Subscribers are
isolated, so one failing listener cannot break job processing. Webhook
forwarding subscribes to these events.

## Running workers

Workers are opt-in. Set `JOBS_WORKERS_ENABLED=true` to start them inside the API
process, or deploy a dedicated worker process. Concurrency is configurable via
`JOBS_CONCURRENCY`.

```bash
JOBS_WORKERS_ENABLED=true JOBS_CONCURRENCY=10 pnpm start
```

## Circuit breaker

External providers (email, payment, Horizon) are wrapped in a `CircuitBreaker`.
After `failureThreshold` consecutive failures the breaker opens and calls fail
fast with `503 CIRCUIT_BREAKER_OPEN`; it probes with a half-open trial after
`resetTimeoutMs` before closing again.
