-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "transactionHash" TEXT,
    "walletAddress" TEXT NOT NULL,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_payout_creator_createdAt" ON "Payout"("creatorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_payout_creator_status" ON "Payout"("creatorId", "status");

-- CreateIndex
CREATE INDEX "idx_payout_status_nextRetryAt" ON "Payout"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "Payout_transactionHash" ON "Payout"("transactionHash");

-- CreateIndex
CREATE INDEX "Payout_createdAt" ON "Payout"("createdAt");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
