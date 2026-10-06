-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "TeamPayoutMode" AS ENUM ('team', 'split');

-- CreateEnum
CREATE TYPE "TeamPayoutStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "CreatorTeam" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "avatar" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verificationNote" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "payoutWalletAddress" TEXT,
    "payoutWalletVerified" BOOLEAN NOT NULL DEFAULT false,
    "payoutMode" "TeamPayoutMode" NOT NULL DEFAULT 'team',
    "pendingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorTeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'member',
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'active',
    "contributionCount" INTEGER NOT NULL DEFAULT 0,
    "contributionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invitedById" TEXT,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRevenueSplit" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRevenueSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamContribution" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "reference" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRevenueDistribution" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XLM',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "reference" TEXT,
    "note" TEXT,
    "distributedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamRevenueDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRevenueShare" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "shareBps" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "credited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamRevenueShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPayout" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "TeamPayoutStatus" NOT NULL DEFAULT 'pending',
    "walletAddress" TEXT NOT NULL,
    "transactionHash" TEXT,
    "errorMessage" TEXT,
    "requestedById" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamAuditLog" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorUserId" TEXT,
    "targetMemberId" TEXT,
    "targetCreatorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorTeam_slug_key" ON "CreatorTeam"("slug");

-- CreateIndex
CREATE INDEX "idx_creatorTeam_public_verified_createdAt" ON "CreatorTeam"("isPublic", "verified", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "idx_creatorTeam_totalEarnings" ON "CreatorTeam"("totalEarnings" DESC);

-- CreateIndex
CREATE INDEX "idx_creatorTeamMember_team_status" ON "CreatorTeamMember"("teamId", "status");

-- CreateIndex
CREATE INDEX "idx_creatorTeamMember_creator_status" ON "CreatorTeamMember"("creatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_creatorTeamMember_team_creator" ON "CreatorTeamMember"("teamId", "creatorId");

-- CreateIndex
CREATE INDEX "idx_teamRevenueSplit_team_enabled" ON "TeamRevenueSplit"("teamId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_teamRevenueSplit_team_member" ON "TeamRevenueSplit"("teamId", "memberId");

-- CreateIndex
CREATE INDEX "idx_teamContribution_team_occurredAt" ON "TeamContribution"("teamId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "idx_teamContribution_team_type" ON "TeamContribution"("teamId", "type");

-- CreateIndex
CREATE INDEX "idx_teamContribution_member_occurredAt" ON "TeamContribution"("memberId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "idx_teamRevenueDistribution_team_createdAt" ON "TeamRevenueDistribution"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_teamRevenueDistribution_source" ON "TeamRevenueDistribution"("source");

-- CreateIndex
CREATE INDEX "idx_teamRevenueShare_distribution" ON "TeamRevenueShare"("distributionId");

-- CreateIndex
CREATE INDEX "idx_teamRevenueShare_member_createdAt" ON "TeamRevenueShare"("memberId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TeamPayout_transactionHash_key" ON "TeamPayout"("transactionHash");

-- CreateIndex
CREATE INDEX "idx_teamPayout_team_status" ON "TeamPayout"("teamId", "status");

-- CreateIndex
CREATE INDEX "idx_teamPayout_team_createdAt" ON "TeamPayout"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_teamPayout_status_createdAt" ON "TeamPayout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "idx_teamAuditLog_team_createdAt" ON "TeamAuditLog"("teamId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_teamAuditLog_team_action" ON "TeamAuditLog"("teamId", "action");

-- AddForeignKey
ALTER TABLE "CreatorTeamMember" ADD CONSTRAINT "CreatorTeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorTeamMember" ADD CONSTRAINT "CreatorTeamMember_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRevenueSplit" ADD CONSTRAINT "TeamRevenueSplit_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRevenueSplit" ADD CONSTRAINT "TeamRevenueSplit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "CreatorTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamContribution" ADD CONSTRAINT "TeamContribution_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamContribution" ADD CONSTRAINT "TeamContribution_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "CreatorTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRevenueDistribution" ADD CONSTRAINT "TeamRevenueDistribution_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRevenueShare" ADD CONSTRAINT "TeamRevenueShare_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "TeamRevenueDistribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRevenueShare" ADD CONSTRAINT "TeamRevenueShare_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "CreatorTeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamPayout" ADD CONSTRAINT "TeamPayout_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamPayout" ADD CONSTRAINT "TeamPayout_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "CreatorTeamMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAuditLog" ADD CONSTRAINT "TeamAuditLog_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "CreatorTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
