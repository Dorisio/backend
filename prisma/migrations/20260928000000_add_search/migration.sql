-- AlterTable: search facets on Creator
ALTER TABLE "Creator" ADD COLUMN     "category" TEXT,
ADD COLUMN     "followerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: generated tsvector kept in sync by trigger (Prisma cannot model generated tsvector columns)
ALTER TABLE "Creator" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("username", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("displayName", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("bio", '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string("tags", ' '), '')), 'D')
  ) STORED;

-- GIN index powering full-text search
CREATE INDEX IF NOT EXISTS "idx_creator_tsv" ON "Creator" USING GIN ("tsv");

-- GIN index for tag facet filtering (tags && ARRAY[..])
CREATE INDEX IF NOT EXISTS "idx_creator_tags" ON "Creator" USING GIN ("tags");

-- CreateTable
CREATE TABLE "SearchQuery" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastSearchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SearchQuery_term_key" ON "SearchQuery"("term");
CREATE INDEX IF NOT EXISTS "idx_searchQuery_count" ON "SearchQuery"("count" DESC);
CREATE INDEX IF NOT EXISTS "idx_searchQuery_term" ON "SearchQuery"("term");
CREATE INDEX IF NOT EXISTS "idx_creator_category" ON "Creator"("category");
CREATE INDEX IF NOT EXISTS "idx_creator_public_verified_followers" ON "Creator"("isPublic", "verified", "followerCount" DESC);

-- Backfill tsv for existing rows (generated columns handle new/updated rows automatically)
-- Note: generated columns are computed on ADD COLUMN, no manual backfill needed.

ANALYZE "Creator";
