-- Issue #29: comprehensive indexing strategy
-- Naming: idx_{table}_{columns}

CREATE INDEX IF NOT EXISTS "idx_user_role" ON "User"("role");
CREATE INDEX IF NOT EXISTS "idx_user_createdAt" ON "User"("createdAt");

-- Prevent duplicate tip submissions for the same chain tx
CREATE UNIQUE INDEX IF NOT EXISTS "Tip_transactionHash_key" ON "Tip"("transactionHash");

CREATE INDEX IF NOT EXISTS "idx_webhookevent_webhookId_status" ON "WebhookEvent"("webhookId", "status");
CREATE INDEX IF NOT EXISTS "idx_webhookevent_createdAt" ON "WebhookEvent"("createdAt");
