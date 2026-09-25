# Asynchronous Job Processing

Issue #27. Built on **BullMQ** + Redis.

## Queues

| Queue | Purpose |
|-------|---------|
| `stellar-confirmation` | Confirm tip txs on Stellar |
| `webhook-dispatch` | Deliver creator webhooks |
| `email` | Outbound email |
| `image-processing` | Avatar/media transforms |
| `analytics` | Heavy rollups |
| `exports` | CSV/JSON exports |
| `dead-letter` | Permanently failed jobs |

## Retries

5 attempts with delays **5s → 30s → 5min → 30min → 24h** (`RETRY_DELAYS_MS`).

## Priorities

`low` (1), `normal` (5), `high` (10). Higher runs first.

## Workers

```bash
ENABLE_WORKERS=true pnpm dev   # in-process
pnpm worker                    # dedicated process
```

Concurrency: `WORKER_CONCURRENCY` (default 10).

## Scheduling

`registerScheduledJobs()` installs daily analytics + weekly export cron jobs.

## APIs

- `GET /api/v1/jobs/health` (admin)
- `GET /api/v1/jobs/:queue/:id`
- `POST /api/v1/jobs/email|analytics|export|images`
