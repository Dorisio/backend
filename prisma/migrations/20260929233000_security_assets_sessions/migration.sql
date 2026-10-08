ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);

CREATE TABLE "StellarAsset" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "issuer" TEXT,
  "name" TEXT NOT NULL,
  "decimals" INTEGER NOT NULL DEFAULT 7,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "feeBps" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StellarAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uniq_stellarAsset_code_issuer" ON "StellarAsset"("code", "issuer");
CREATE INDEX "idx_stellarAsset_enabled_priority" ON "StellarAsset"("enabled", "priority");

ALTER TABLE "Tip" ADD COLUMN "assetId" TEXT;
ALTER TABLE "Tip" ADD COLUMN "assetCode" TEXT NOT NULL DEFAULT 'USDC';
ALTER TABLE "Tip" ADD COLUMN "assetIssuer" TEXT;
ALTER TABLE "Tip" ADD COLUMN "assetDecimals" INTEGER NOT NULL DEFAULT 7;
CREATE INDEX "idx_tip_asset_createdAt" ON "Tip"("assetId", "createdAt");
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "StellarAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Creator" ADD COLUMN "defaultAssetId" TEXT;
ALTER TABLE "Creator" ADD CONSTRAINT "Creator_defaultAssetId_fkey" FOREIGN KEY ("defaultAssetId") REFERENCES "StellarAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "device" TEXT,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");
CREATE INDEX "Session_userId_revokedAt_expiresAt_idx" ON "Session"("userId", "revokedAt", "expiresAt");
CREATE INDEX "Session_lastActivity_idx" ON "Session"("lastActivity");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AuthAttempt" (
  "id" TEXT NOT NULL,
  "email" TEXT,
  "ipAddress" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuthAttempt_ipAddress_action_createdAt_idx" ON "AuthAttempt"("ipAddress", "action", "createdAt");
CREATE INDEX "AuthAttempt_email_action_createdAt_idx" ON "AuthAttempt"("email", "action", "createdAt");
