# Redis and queue runbook

## Symptoms

Check `/health`, Redis connectivity, BullMQ queue depth, worker error rates,
and delayed/retried jobs. A full queue or repeated connection failures can
make payments appear stuck while the API remains healthy.

## Safe response

1. Assign the incident commander and record the affected queue and UTC time.
2. Pause nonessential producers if queue growth threatens Redis memory.
3. Fix connectivity or fail over to the approved Redis endpoint; do not flush
   the database as a troubleshooting step.
4. Resume workers gradually and verify idempotency, webhook delivery, and
   Stellar confirmation state before clearing retries.
5. Reconcile permanently failed jobs using the job's documented recovery path.

Escalate suspected data loss, duplicate payment risk, or unavailable Redis
failover to the operations and security owners.
