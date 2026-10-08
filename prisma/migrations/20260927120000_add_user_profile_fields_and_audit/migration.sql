-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "bio" TEXT;

-- CreateTable
CREATE TABLE "ProfileChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_profileChange_user_createdAt" ON "ProfileChange"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "idx_profileChange_user_sensitive_createdAt" ON "ProfileChange"("userId", "sensitive", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ProfileChange" ADD CONSTRAINT "ProfileChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
