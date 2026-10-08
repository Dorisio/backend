-- Issue #56: indexes backing database-side tip filtering and search.
--
-- Before this change the listing endpoints only accepted pagination and a
-- single status filter; every other slice forced a sequential scan of "Tip".
-- Each index below backs one concrete filter added in this PR:
--   * creator-scoped amount band          -> (creatorId, amount)
--   * creator-scoped date range           -> (creatorId, createdAt)
--   * global (admin) date range search    -> (createdAt)
--   * global (admin) amount band search   -> (amount)
--   * status + amount band                -> (status, amount)
--   * sender-scoped amount band           -> (fromUserId, amount)
--
-- Equality columns come first so PostgreSQL can use the index for both the
-- WHERE clause and the ORDER BY. All statements are idempotent, so the migration
-- is safe to re-run. The same indexes are declared on the Tip model in
-- prisma/schema.prisma, so tooling sees no drift.

CREATE INDEX IF NOT EXISTS "idx_tip_creator_amount" ON "Tip"("creatorId", "amount");

CREATE INDEX IF NOT EXISTS "idx_tip_creator_createdAt_range" ON "Tip"("creatorId", "createdAt");

CREATE INDEX IF NOT EXISTS "idx_tip_createdAt" ON "Tip"("createdAt");

CREATE INDEX IF NOT EXISTS "idx_tip_amount" ON "Tip"("amount");

CREATE INDEX IF NOT EXISTS "idx_tip_status_amount" ON "Tip"("status", "amount");

CREATE INDEX IF NOT EXISTS "idx_tip_fromUser_amount" ON "Tip"("fromUserId", "amount");

-- Keep planner statistics fresh so it can choose between index and sequential
-- scans now that the queries are shaped differently.
ANALYZE "Tip";
