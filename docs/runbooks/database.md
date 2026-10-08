# Database runbook

## Symptoms

Use `/health`, database connection-pool metrics, and PostgreSQL activity to
distinguish a database outage from application saturation. Check whether
failed migrations or long-running queries started at the same time.

## Safe response

1. Page the database owner and record the UTC timestamp.
2. Stop or rate-limit nonessential workers before restarting the database.
3. Do not run ad-hoc destructive SQL. Inspect first and use the versioned
   Prisma migration or reviewed migration runner.
4. If a migration failed, preserve the error and follow the migration's
   documented down path; never delete `_prisma_migrations` records manually.
5. Restore traffic gradually and verify reads, writes, queue processing, and a
   safe payment flow.

## Escalation

Escalate immediately for data loss, corruption, suspected credential exposure,
or a migration that cannot be rolled back safely. Include the migration name,
database error, affected release, and recovery point information without
including connection strings or secrets.
