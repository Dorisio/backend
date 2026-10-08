-- Notification center, per-type channel preferences and digest settings (issue #58).

CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'email', 'push');
CREATE TYPE "NotificationStatus" AS ENUM ('queued', 'sent', 'skipped', 'failed');
CREATE TYPE "NotificationDigestFrequency" AS ENUM ('off', 'daily', 'weekly');

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'queued',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

CREATE INDEX "Notification_userId_channel_readAt_idx" ON "Notification"("userId", "channel", "readAt");

CREATE INDEX "Notification_expiresAt_idx" ON "Notification"("expiresAt");

CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_eventType_channel_key" ON "NotificationPreference"("userId", "eventType", "channel");

CREATE INDEX "NotificationPreference_userId_eventType_idx" ON "NotificationPreference"("userId", "eventType");

CREATE TABLE "NotificationDigestSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "frequency" "NotificationDigestFrequency" NOT NULL DEFAULT 'off',
    "channel" "NotificationChannel" NOT NULL DEFAULT 'email',
    "hourUtc" INTEGER NOT NULL DEFAULT 8,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDigestSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDigestSetting_userId_key" ON "NotificationDigestSetting"("userId");

CREATE INDEX "NotificationDigestSetting_frequency_idx" ON "NotificationDigestSetting"("frequency");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDigestSetting" ADD CONSTRAINT "NotificationDigestSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
