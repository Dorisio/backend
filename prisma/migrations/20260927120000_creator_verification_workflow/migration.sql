ALTER TABLE "Creator"
ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedUntil" TIMESTAMP(3);

CREATE TABLE "CreatorVerificationRequest" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "statement" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorVerificationRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreatorVerificationRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CreatorVerificationRequest_status_createdAt_idx" ON "CreatorVerificationRequest"("status", "createdAt");
CREATE INDEX "CreatorVerificationRequest_creatorId_createdAt_idx" ON "CreatorVerificationRequest"("creatorId", "createdAt");
CREATE INDEX "CreatorVerificationRequest_expiresAt_idx" ON "CreatorVerificationRequest"("expiresAt");
-- Enforce one pending submission per creator even when requests race concurrently.
CREATE UNIQUE INDEX "CreatorVerificationRequest_one_submitted_per_creator"
ON "CreatorVerificationRequest"("creatorId") WHERE "status" = 'submitted';

CREATE TABLE "CreatorVerificationDocument" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorVerificationDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreatorVerificationDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreatorVerificationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreatorVerificationDocument_storageKey_key" ON "CreatorVerificationDocument"("storageKey");
CREATE INDEX "CreatorVerificationDocument_requestId_idx" ON "CreatorVerificationDocument"("requestId");

CREATE TABLE "CreatorVerificationEvent" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "requestId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorVerificationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreatorVerificationEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CreatorVerificationEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreatorVerificationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "CreatorVerificationEvent_creatorId_createdAt_idx" ON "CreatorVerificationEvent"("creatorId", "createdAt");
CREATE INDEX "CreatorVerificationEvent_requestId_createdAt_idx" ON "CreatorVerificationEvent"("requestId", "createdAt");
