# Database Indexing Strategy

Issue #29.

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
