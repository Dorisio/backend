-- Content moderation and abuse reporting (issue #62).
--
-- Adds the moderation state to tips, the report + appeal tables and the
-- append-only moderation audit trail.

-- Public tip reads filter on this column (`visible`), so it is indexed.
ALTER TABLE "Tip"
ADD COLUMN "moderationState" TEXT NOT NULL DEFAULT 'visible';

CREATE INDEX "idx_tip_moderationState" ON "Tip" ("moderationState");

CREATE TABLE "Report" (
  "id" TEXT NOT NULL,
  "reporterId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "reportType" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "details" TEXT,
  "status" TEXT NOT NULL DEFAULT 'reported',
  "decision" TEXT NOT NULL DEFAULT 'none',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "priorityRank" INTEGER NOT NULL DEFAULT 2,
  "resolution" TEXT,
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "assignedTo" TEXT,
  "autoFlagged" BOOLEAN NOT NULL DEFAULT false,
  "spamScore" INTEGER NOT NULL DEFAULT 0,
  "spamSignals" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- Open queue: status filter, urgency, then oldest first.
CREATE INDEX "idx_report_status_priority_createdAt" ON "Report" ("status", "priorityRank", "createdAt");
CREATE INDEX "idx_report_target" ON "Report" ("targetType", "targetId");
CREATE INDEX "idx_report_reporter_createdAt" ON "Report" ("reporterId", "createdAt" DESC);
CREATE INDEX "idx_report_reportedType_status" ON "Report" ("reportType", "status");

-- One open report per reporter per target and type. Prisma cannot express a
-- partial unique index, so it is declared here: the service pre-checks and maps
-- the resulting conflict to a 409, and this index is what makes it airtight
-- under concurrency.
CREATE UNIQUE INDEX "report_open_unique" ON "Report" ("reporterId", "targetType", "targetId", "reportType")
WHERE "status" IN ('reported', 'investigating');

CREATE TABLE "ReportAppeal" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "appellantId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "notes" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReportAppeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_reportAppeal_status_createdAt" ON "ReportAppeal" ("status", "createdAt");

ALTER TABLE "ReportAppeal"
ADD CONSTRAINT "ReportAppeal_reportId_fkey"
FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ModerationAction" (
  "id" TEXT NOT NULL,
  "reportId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_moderationAction_target_createdAt" ON "ModerationAction" ("targetType", "targetId", "createdAt");
CREATE INDEX "idx_moderationAction_report_createdAt" ON "ModerationAction" ("reportId", "createdAt");
CREATE INDEX "idx_moderationAction_action_createdAt" ON "ModerationAction" ("action", "createdAt");
