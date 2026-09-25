-- Issue #12: query performance optimization & indexing strategy
--
-- Every index below backs a concrete query shape in the application code.
-- Composite columns follow the "equality filters first, then sort columns"
-- rule so PostgreSQL can satisfy both the WHERE clause and the ORDER BY from
-- a single index (no separate sort node).
--
-- Naming: idx_{table}_{columns}
-- All statements are idempotent so the migration is safe to re-run.

-- User: admin listing filters by role and orders by recency.
CREATE INDEX IF NOT EXISTS "idx_user_role_createdAt" ON "User"("role", "createdAt" DESC);

-- Creator: public discovery feed (isPublic filter + newest-first keyset order).
CREATE INDEX IF NOT EXISTS "idx_creator_public_createdAt"
  ON "Creator"("isPublic", "createdAt" DESC, id DESC);

-- Creator: verified public leaderboard (CreatorService.listCreators sort=totalEarnings).
CREATE INDEX IF NOT EXISTS "idx_creator_public_verified_earnings"
  ON "Creator"("isPublic", "verified", "totalEarnings" DESC);

-- Creator: global top-earners ranking (AnalyticsService.getTopCreators).
CREATE INDEX IF NOT EXISTS "idx_creator_totalEarnings" ON "Creator"("totalEarnings" DESC);

-- Tip: creator history without a status filter (PaymentService.listTips default sort).
CREATE INDEX IF NOT EXISTS "idx_tip_creator_createdAt"
  ON "Tip"("creatorId", "createdAt" DESC, id DESC);

-- Tip: user history filtered by status (getUserTipHistory).
CREATE INDEX IF NOT EXISTS "idx_tip_fromUser_status_createdAt"
  ON "Tip"("fromUserId", "status", "createdAt" DESC);

-- Tip: global status sweeps ordered by time (reconciliation workers).
CREATE INDEX IF NOT EXISTS "idx_tip_status_createdAt" ON "Tip"("status", "createdAt");

-- Tip: top-supporters aggregation groups by supporter after the creator/status filter.
CREATE INDEX IF NOT EXISTS "idx_tip_creator_status_fromUser"
  ON "Tip"("creatorId", "status", "fromUserId");

-- Webhook: per-creator listing, newest first.
CREATE INDEX IF NOT EXISTS "idx_webhook_creator_createdAt"
  ON "Webhook"("creatorId", "createdAt" DESC);

-- Webhook: dispatch workers only fan out to active endpoints.
CREATE INDEX IF NOT EXISTS "idx_webhook_creator_active_createdAt"
  ON "Webhook"("creatorId", "active", "createdAt" DESC);

-- WebhookEvent: delivery log listing per webhook, newest first.
CREATE INDEX IF NOT EXISTS "idx_webhookEvent_webhook_createdAt"
  ON "WebhookEvent"("webhookId", "createdAt" DESC);

-- WebhookEvent: retry sweeps process the oldest pending/failed events first.
CREATE INDEX IF NOT EXISTS "idx_webhookEvent_status_createdAt"
  ON "WebhookEvent"("status", "createdAt");

-- WalletFlag: moderation queue ordered by severity then recency.
CREATE INDEX IF NOT EXISTS "idx_walletFlag_resolved_severity_createdAt"
  ON "WalletFlag"("resolved", "severity", "createdAt" DESC);

-- AccountFreeze: freeze history per creator, newest first.
CREATE INDEX IF NOT EXISTS "idx_accountFreeze_creator_resolved_createdAt"
  ON "AccountFreeze"("creatorId", "resolved", "createdAt" DESC);

-- AccountFreeze: expiry sweep only looks at unresolved rows, oldest expiry first.
CREATE INDEX IF NOT EXISTS "idx_accountFreeze_resolved_expiresAt"
  ON "AccountFreeze"("resolved", "expiresAt");

-- Keep planner statistics fresh so it can pick between index and sequential scans.
ANALYZE "User";
ANALYZE "Creator";
ANALYZE "Tip";
ANALYZE "Webhook";
ANALYZE "WebhookEvent";
ANALYZE "WalletFlag";
ANALYZE "AccountFreeze";
