# Database Indexing Strategy

Issue #29 (baseline) and issue #12 (query performance overlay, see
[QUERY_PERFORMANCE.md](./QUERY_PERFORMANCE.md)).

## Principles

1. **Always index foreign keys** used in joins/filters (`userId`, `creatorId`, `fromUserId`, `webhookId`).
2. **Index high-cardinality filters** (`status`, `verified`, `isPublic`, `role`).
3. **Index time columns** used for range scans (`createdAt`, `updatedAt`, `expiresAt`).
4. **Composite indexes** match real `WHERE` + `ORDER BY` shapes leftmost-prefix friendly.
5. **Unique constraints** protect invariants (`email`, `username`, `transactionHash`).

## Current indexes (Prisma)

| Table | Index / unique | Purpose |
|-------|----------------|---------|
| User | `email` unique | login |
| User | `@@index([role])` | admin filters |
| User | `@@index([createdAt])` | time listings |
| Creator | `userId` unique, `username` unique | ownership / profile |
| Creator | `@@index([verified, isPublic])` | discovery |
| Wallet | `publicKey` unique, `@@index([userId, verified])` | wallet lookup |
| Tip | `@@index([creatorId, status, createdAt])` | creator tip feeds |
| Tip | `@@index([fromUserId, createdAt])` | fan history |
| Tip | `@@index([status])` | ops queues |
| Tip | `transactionHash` unique | idempotent settlement |
| Webhook | `@@index([creatorId])` | creator webhooks |
| WebhookEvent | `@@index([webhookId])`, `@@index([status])`, `@@index([webhookId, status])`, `@@index([createdAt])` | delivery retries |
| BlacklistedToken | `token` unique, `@@index([expiresAt])` | auth revocation |
| WalletFlag / AccountFreeze | severity/resolved/expires indexes | admin tooling |

## Indexes added for query performance (issue #12)

All of these are declared with an explicit `map:` name so the Prisma schema and
the SQL migration stay in sync, and are created idempotently in
`prisma/migrations/20260925120000_query_performance_indexes/migration.sql`.

| Index | Leading columns | Query it serves |
|-------|-----------------|-----------------|
| `idx_user_role_createdAt` | `role, createdAt desc` | admin user listings |
| `idx_creator_public_createdAt` | `isPublic, createdAt desc, id desc` | public creator feed (stable, non-skip pagination) |
| `idx_creator_public_verified_earnings` | `isPublic, verified, totalEarnings desc` | top-creator leaderboard |
| `idx_creator_totalEarnings` | `totalEarnings desc` | payout/earnings ordering |
| `idx_tip_creator_createdAt` | `creatorId, createdAt desc, id desc` | creator tip feed |
| `idx_tip_fromUser_status_createdAt` | `fromUserId, status, createdAt desc` | fan history filtered by status |
| `idx_tip_status_createdAt` | `status, createdAt desc` | pending/confirmed settlement queues |
| `idx_tip_creator_status_fromUser` | `creatorId, status, fromUserId` | per-creator earnings breakdown grouped by sender |
| `idx_webhook_creator_createdAt` | `creatorId, createdAt desc` | creator webhook list |
| `idx_webhook_creator_active_createdAt` | `creatorId, active, createdAt desc` | active webhook dispatch |
| `idx_webhookEvent_webhook_createdAt` | `webhookId, createdAt desc` | delivery history per webhook |
| `idx_webhookEvent_status_createdAt` | `status, createdAt desc` | failed-delivery retry queue |
| `idx_walletFlag_resolved_severity_createdAt` | `resolved, severity, createdAt desc` | admin review queue |
| `idx_accountFreeze_creator_resolved_createdAt` | `creatorId, resolved, createdAt desc` | freeze history per creator |
| `idx_accountFreeze_resolved_expiresAt` | `resolved, expiresAt` | expiry sweep over active freezes |

Design rules used throughout:

1. **Equality columns first, sort columns last.** The planner can then satisfy
   `WHERE` + `ORDER BY` from a single index and skip the `Sort` node.
2. **`id` as the final column** wherever the service orders by `createdAt` and
   paginates by offset — it makes the ordering total, so two rows with the same
   timestamp can never swap places between pages.
3. **No index on a boolean alone.** `isPublic`/`active`/`verified` are only
   useful as leading columns when combined with a selective column.
4. **Redundant prefixes are kept** (`idx_tip_status_createdAt` alongside
   `idx_tip_fromUser_status_createdAt`) because queue-style queries filter on
   `status` alone and would otherwise not use the composite index.

## Deployment

Apply with Prisma migrate (online-friendly `CREATE INDEX IF NOT EXISTS` in SQL migration):

```bash
pnpm prisma migrate deploy
```

## Verification

```sql
EXPLAIN ANALYZE
SELECT * FROM "Tip"
WHERE "creatorId" = $1 AND "status" = 'confirmed'
ORDER BY "createdAt" DESC
LIMIT 20;
```

Expect an index scan on `Tip_creatorId_status_createdAt_idx` (or equivalent).

Against a live instance the same check is available over HTTP:

```bash
curl -s -X POST http://localhost:3000/diagnostics/queries/explain \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM \"Tip\" WHERE \"creatorId\" = $1 ORDER BY \"createdAt\" DESC LIMIT 20","params":["<creator-id>"]}' \
  | jq '.indexNames, .recommendations'
```

The response lists the indexes the planner chose plus concrete recommendations
(missing index for a sequential scan, sort too large for the work_mem budget,
row estimates that drifted, and so on).
