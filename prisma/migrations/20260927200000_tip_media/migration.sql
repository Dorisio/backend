-- Tip message media (#64): upload reservations, processing state, storage quota.

-- CreateTable
CREATE TABLE "TipMedia" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tipId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "derivatives" JSONB NOT NULL DEFAULT '[]',
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "processingError" TEXT,
    "scanner" TEXT,
    "scanSignature" TEXT,
    "scanCompletedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TipMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaQuota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedBytes" INTEGER NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "limitBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TipMedia_storageKey_key" ON "TipMedia"("storageKey");

-- CreateIndex
CREATE INDEX "idx_tipMedia_user_status_createdAt" ON "TipMedia"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_tipMedia_tip_attachedAt" ON "TipMedia"("tipId", "attachedAt");

-- CreateIndex
CREATE INDEX "idx_tipMedia_status_createdAt" ON "TipMedia"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaQuota_userId_key" ON "MediaQuota"("userId");

-- AddForeignKey
ALTER TABLE "TipMedia" ADD CONSTRAINT "TipMedia_tipId_fkey" FOREIGN KEY ("tipId") REFERENCES "Tip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Media is only attachable while it is `ready`; the partial index keeps the
-- attach path (find ready media owned by the tipper) cheap without indexing the
-- pending/rejected majority.
CREATE INDEX "idx_tipMedia_ready_user" ON "TipMedia"("userId") WHERE "status" = 'ready';
