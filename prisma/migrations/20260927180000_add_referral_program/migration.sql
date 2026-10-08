-- CreateTable: ReferralTier
CREATE TABLE "ReferralTier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferralCode
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tierId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lockedAt" TIMESTAMP(3),
    "lockReason" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Referral
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ReferralCommission
CREATE TABLE "ReferralCommission" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "tipId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "commissionRate" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XLM',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: ReferralTier
CREATE UNIQUE INDEX "ReferralTier_name_key" ON "ReferralTier"("name");
CREATE INDEX "ReferralTier_isDefault_idx" ON "ReferralTier"("isDefault");

-- CreateIndex: ReferralCode
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE INDEX "ReferralCode_userId_isActive_idx" ON "ReferralCode"("userId", "isActive");
CREATE INDEX "ReferralCode_code_idx" ON "ReferralCode"("code");
CREATE INDEX "idx_referralCode_user_createdAt" ON "ReferralCode"("userId", "createdAt" DESC);

-- CreateIndex: Referral
CREATE UNIQUE INDEX "Referral_refereeId_key" ON "Referral"("refereeId");
CREATE INDEX "Referral_referralCodeId_status_idx" ON "Referral"("referralCodeId", "status");
CREATE INDEX "Referral_refereeId_idx" ON "Referral"("refereeId");
CREATE INDEX "Referral_status_createdAt_idx" ON "Referral"("status", "createdAt");
CREATE INDEX "idx_referral_code_createdAt" ON "Referral"("referralCodeId", "createdAt" DESC);

-- CreateIndex: ReferralCommission
CREATE UNIQUE INDEX "ReferralCommission_tipId_key" ON "ReferralCommission"("tipId");
CREATE INDEX "ReferralCommission_referrerId_status_idx" ON "ReferralCommission"("referrerId", "status");
CREATE INDEX "ReferralCommission_referralId_status_idx" ON "ReferralCommission"("referralId", "status");
CREATE INDEX "ReferralCommission_status_createdAt_idx" ON "ReferralCommission"("status", "createdAt");
CREATE INDEX "idx_referralCommission_referrer_status_createdAt" ON "ReferralCommission"("referrerId", "status", "createdAt");

-- AddForeignKey: ReferralCode
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "ReferralTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Referral
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: ReferralCommission
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_tipId_fkey" FOREIGN KEY ("tipId") REFERENCES "Tip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
