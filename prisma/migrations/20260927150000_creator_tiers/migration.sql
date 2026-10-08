-- Creator subscription tiers (free / pro / enterprise) with usage counters and invoices.

CREATE TYPE "CreatorTierLevel" AS ENUM ('free', 'pro', 'enterprise');
CREATE TYPE "CreatorSubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'expired');
CREATE TYPE "CreatorInvoiceStatus" AS ENUM ('open', 'paid', 'void', 'uncollectible');

CREATE TABLE "CreatorSubscription" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "tier" "CreatorTierLevel" NOT NULL DEFAULT 'free',
    "status" "CreatorSubscriptionStatus" NOT NULL DEFAULT 'active',
    "billingPeriod" TEXT NOT NULL DEFAULT 'monthly',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "nextTier" "CreatorTierLevel",
    "provider" TEXT NOT NULL DEFAULT 'internal',
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorSubscription_creatorId_key" ON "CreatorSubscription"("creatorId");

CREATE INDEX "CreatorSubscription_tier_status_idx" ON "CreatorSubscription"("tier", "status");

CREATE INDEX "CreatorSubscription_status_currentPeriodEnd_idx" ON "CreatorSubscription"("status", "currentPeriodEnd");

CREATE TABLE "CreatorUsage" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "apiRequests" INTEGER NOT NULL DEFAULT 0,
    "analyticsQueries" INTEGER NOT NULL DEFAULT 0,
    "exports" INTEGER NOT NULL DEFAULT 0,
    "tipCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorUsage_creatorId_period_key" ON "CreatorUsage"("creatorId", "period");

CREATE INDEX "CreatorUsage_period_idx" ON "CreatorUsage"("period");

CREATE TABLE "CreatorInvoice" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "number" TEXT NOT NULL,
    "status" "CreatorInvoiceStatus" NOT NULL DEFAULT 'open',
    "tier" "CreatorTierLevel" NOT NULL,
    "billingPeriod" TEXT NOT NULL DEFAULT 'monthly',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "lineItems" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "provider" TEXT NOT NULL DEFAULT 'internal',
    "providerInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorInvoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorInvoice_number_key" ON "CreatorInvoice"("number");

CREATE INDEX "CreatorInvoice_creatorId_issuedAt_idx" ON "CreatorInvoice"("creatorId", "issuedAt" DESC);

CREATE INDEX "CreatorInvoice_status_idx" ON "CreatorInvoice"("status");

ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorUsage" ADD CONSTRAINT "CreatorUsage_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorInvoice" ADD CONSTRAINT "CreatorInvoice_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorInvoice" ADD CONSTRAINT "CreatorInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CreatorSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
