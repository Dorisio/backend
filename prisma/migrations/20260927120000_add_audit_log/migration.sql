CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "resourceId" TEXT,
  "changes" JSONB NOT NULL DEFAULT '{}',
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "requestId" TEXT,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_resource_resourceId_timestamp_idx" ON "AuditLog"("resource", "resourceId", "timestamp");
CREATE INDEX "AuditLog_userId_timestamp_idx" ON "AuditLog"("userId", "timestamp");
CREATE INDEX "AuditLog_action_timestamp_idx" ON "AuditLog"("action", "timestamp");
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");
