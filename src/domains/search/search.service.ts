import { Prisma, PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { getOrFetch, createCacheKey, CacheType } from '../../lib/cache/cache-aside';
import {
  DEFAULT_PAGE_SIZE,
  formatOffsetPaginatedResult,
  sanitizePageNumber,
  sanitizePageSize,
  OffsetPaginatedResult,
} from '../../utils/pagination';

export interface SearchFilters {
  q?: string;
  category?: string;
  tag?: string;
  verified?: boolean;
}

export interface SearchParams extends SearchFilters {
  page?: number | string;
  pageSize?: number | string;
}

export interface SearchResultItem {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatar: string | null;
  verified: boolean;
  followerCount: number;
  category: string | null;
  tags: string[];
  relevance: number;
}

export interface SearchFacets {
  categories: { value: string; count: number }[];
  tags: { value: string; count: number }[];
  verified: { value: boolean; count: number }[];
}

export type SearchResult = OffsetPaginatedResult<SearchResultItem> & {
  facets: SearchFacets;
};

export interface AutocompleteResult {
  creators: {
    id: string;
    username: string;
    displayName: string | null;
    avatar: string | null;
    verified: boolean;
  }[];
  terms: { term: string; count: number }[];
}

interface SearchRow {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatar: string | null;
  verified: boolean;
  followerCount: number;
  category: string | null;
  tags: string[] | null;
  rank: number;
}

const FACET_LIMIT = 20;
const AUTOCOMPLETE_CREATOR_LIMIT = 8;
const AUTOCOMPLETE_TERM_LIMIT = 5;
const AUTOCOMPLETE_TTL_MS = 30_000;
const MIN_INDEXED_TERM_LENGTH = 2;
const MAX_INDEXED_TERM_LENGTH = 100;

/**
 * Creator discovery over PostgreSQL full-text search.
 *
 * The `tsv` generated column (weighted A-D over username/displayName/bio/tags)
 * is maintained by the database and covered by a GIN index. Ranking is
 * popularity-first — verified creators, then followerCount — with ts_rank as
 * the relevance tie-breaker.
 */
export class SearchService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  /**
   * Builds the WHERE clause shared by the result, count, and facet queries.
   * `omit` drops a dimension so each facet can list its own alternatives
   * instead of collapsing to the single selected value.
   */
  private buildWhere(filters: SearchFilters, omit?: 'category' | 'tag' | 'verified') {
    const conditions = [Prisma.sql`"isPublic" = true`];
    const term = filters.q?.trim();
    if (term) {
      conditions.push(Prisma.sql`"tsv" @@ websearch_to_tsquery('english', ${term})`);
    }
    if (filters.category && omit !== 'category') {
      conditions.push(Prisma.sql`"category" = ${filters.category}`);
    }
    if (filters.tag && omit !== 'tag') {
      conditions.push(Prisma.sql`"tags" && ARRAY[${filters.tag}]::text[]`);
    }
    if (filters.verified !== undefined && omit !== 'verified') {
      conditions.push(Prisma.sql`"verified" = ${filters.verified}`);
    }
    return Prisma.join(conditions, ' AND ');
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const page = sanitizePageNumber(params.page);
    const pageSize = sanitizePageSize(params.pageSize, DEFAULT_PAGE_SIZE);

    const filters: SearchFilters = {
      q: params.q?.trim() || undefined,
      category: params.category?.trim() || undefined,
      tag: params.tag?.trim() || undefined,
      verified: params.verified,
    };

    const cacheId = encodeURIComponent(JSON.stringify({ ...filters, page, pageSize }));
    const result = await getOrFetch<SearchResult>({
      key: createCacheKey(CacheType.SEARCH, cacheId),
      type: CacheType.SEARCH,
      fetchFn: () => this.executeSearch(filters, page, pageSize),
    });

    if (filters.q) {
      await this.recordSearch(filters.q);
    }
    return result;
  }

  private async executeSearch(
    filters: SearchFilters,
    page: number,
    pageSize: number
  ): Promise<SearchResult> {
    const where = this.buildWhere(filters);
    const offset = (page - 1) * pageSize;
    const term = filters.q ?? '';

    const [rows, countRows, categories, tags, verifiedCounts] = await Promise.all([
      this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT "id", "userId", "username", "displayName", "bio", "avatar",
               "verified", "followerCount", "category", "tags",
               ts_rank("tsv", websearch_to_tsquery('english', ${term})) AS "rank"
        FROM "Creator"
        WHERE ${where}
        ORDER BY "verified" DESC, "followerCount" DESC, "rank" DESC, "id" ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<{ count: number }[]>(
        Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "Creator" WHERE ${where}`
      ),
      this.prisma.$queryRaw<{ value: string; count: number }[]>(Prisma.sql`
        SELECT "category" AS "value", COUNT(*)::int AS "count"
        FROM "Creator"
        WHERE ${this.buildWhere(filters, 'category')} AND "category" IS NOT NULL
        GROUP BY "category"
        ORDER BY "count" DESC, "value" ASC
        LIMIT ${FACET_LIMIT}
      `),
      this.prisma.$queryRaw<{ value: string; count: number }[]>(Prisma.sql`
        SELECT t AS "value", COUNT(*)::int AS "count"
        FROM "Creator", unnest("tags") AS t
        WHERE ${this.buildWhere(filters, 'tag')}
        GROUP BY t
        ORDER BY "count" DESC, "value" ASC
        LIMIT ${FACET_LIMIT}
      `),
      this.prisma.$queryRaw<{ value: boolean; count: number }[]>(Prisma.sql`
        SELECT "verified" AS "value", COUNT(*)::int AS "count"
        FROM "Creator"
        WHERE ${this.buildWhere(filters, 'verified')}
        GROUP BY "verified"
        ORDER BY "value" DESC
      `),
    ]);

    const items: SearchResultItem[] = rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      avatar: row.avatar,
      verified: row.verified,
      followerCount: Number(row.followerCount ?? 0),
      category: row.category,
      tags: row.tags ?? [],
      relevance: Number(row.rank ?? 0),
    }));

    const total = countRows[0]?.count ?? 0;

    return {
      ...formatOffsetPaginatedResult(items, total, page, pageSize),
      facets: {
        categories,
        tags,
        verified: verifiedCounts,
      },
    };
  }

  async autocomplete(rawQuery: string): Promise<AutocompleteResult> {
    const query = rawQuery.trim();
    if (!query) {
      return { creators: [], terms: [] };
    }

    return getOrFetch<AutocompleteResult>({
      key: createCacheKey(CacheType.SEARCH, `ac:${encodeURIComponent(query.toLowerCase())}`),
      type: CacheType.SEARCH,
      ttlMs: AUTOCOMPLETE_TTL_MS,
      fetchFn: () => this.executeAutocomplete(query),
    });
  }

  private async executeAutocomplete(query: string): Promise<AutocompleteResult> {
    const [creators, terms] = await Promise.all([
      this.prisma.creator.findMany({
        where: {
          isPublic: true,
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { displayName: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatar: true,
          verified: true,
        },
        orderBy: [{ verified: 'desc' }, { followerCount: 'desc' }],
        take: AUTOCOMPLETE_CREATOR_LIMIT,
      }),
      this.prisma.searchQuery.findMany({
        where: { term: { startsWith: query.toLowerCase() } },
        select: { term: true, count: true },
        orderBy: { count: 'desc' },
        take: AUTOCOMPLETE_TERM_LIMIT,
      }),
    ]);

    return { creators, terms };
  }

  async getTrendingSearches(limit: number = 10) {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    return getOrFetch<{ term: string; count: number; lastSearchedAt: Date }[]>({
      key: createCacheKey(CacheType.SEARCH, `trending:${safeLimit}`),
      type: CacheType.SEARCH,
      fetchFn: () =>
        this.prisma.searchQuery.findMany({
          select: { term: true, count: true, lastSearchedAt: true },
          orderBy: { count: 'desc' },
          take: safeLimit,
        }),
    });
  }

  /**
   * Persists search analytics (upsert on the normalized term). Failures are
   * logged but never surface to the caller — analytics must not break search.
   */
  private async recordSearch(rawTerm: string): Promise<void> {
    const term = rawTerm
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_INDEXED_TERM_LENGTH);

    if (term.length < MIN_INDEXED_TERM_LENGTH) {
      return;
    }

    try {
      await this.prisma.searchQuery.upsert({
        where: { term },
        create: { term },
        update: { count: { increment: 1 }, lastSearchedAt: new Date() },
      });
    } catch (error) {
      this.log.warn(
        { err: error, term },
        'Failed to record search analytics'
      );
    }
  }
}
