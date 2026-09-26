-- Issue #48: concurrent payment race-condition guards on the Tip model.
--
-- Three layers of defence:
--   1. `version` column backing optimistic locking (application-level CAS).
--   2. A CHECK constraint pinning `status` to the known lifecycle values.
--   3. A trigger that rejects invalid status transitions at the database,
--      independent of the application code path that issued the write.

-- Optimistic locking + idempotent tip submission.
ALTER TABLE "Tip"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Tip"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- Unique per client key so a retried create cannot charge twice. Nullable keys
-- are ignored by the unique index, matching the "idempotency is opt-in" model.
CREATE UNIQUE INDEX IF NOT EXISTS "Tip_idempotencyKey_key" ON "Tip"("idempotencyKey");

-- Governance: only known lifecycle states may be persisted.
ALTER TABLE "Tip" DROP CONSTRAINT IF EXISTS "Tip_status_check";
ALTER TABLE "Tip"
  ADD CONSTRAINT "Tip_status_check"
  CHECK ("status" IN ('pending', 'completed', 'failed', 'cancelled'));

-- Terminal states must never be re-entered. Mirrors the application state
-- machine in PaymentService.updateTipStatus, enforced even for writers that
-- bypass the service (raw SQL, other services, future workers).
CREATE OR REPLACE FUNCTION tip_enforce_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'pending' AND NEW."status" IN ('completed', 'failed', 'cancelled')) OR
      (OLD."status" = 'failed'  AND NEW."status" = 'pending')
    ) THEN
      RAISE EXCEPTION 'invalid tip status transition: % -> %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tip_status_transition_guard" ON "Tip";
CREATE TRIGGER "tip_status_transition_guard"
  BEFORE UPDATE ON "Tip"
  FOR EACH ROW
  EXECUTE FUNCTION tip_enforce_status_transition();

-- Keep the invariant queryable by the confirmation workers.
ANALYZE "Tip";
