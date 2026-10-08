-- AlterTable
ALTER TABLE "Webhook" ADD COLUMN "previousSecret" TEXT,
ADD COLUMN "secretRotatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WebhookNonce" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookNonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookNonce_nonce_key" ON "WebhookNonce"("nonce");

-- CreateIndex
CREATE INDEX "WebhookNonce_webhookId_timestamp_idx" ON "WebhookNonce"("webhookId", "timestamp");

-- CreateIndex
CREATE INDEX "WebhookNonce_expiresAt_idx" ON "WebhookNonce"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookNonce_nonce_idx" ON "WebhookNonce"("nonce");

-- AddForeignKey
ALTER TABLE "WebhookNonce" ADD CONSTRAINT "WebhookNonce_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
