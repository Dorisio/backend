import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchService } from '../search.service';

// The service composes queries with Prisma.sql and hands the resulting Sql
// object to `$queryRaw` as a SINGLE argument: `$queryRaw(sqlObject)`. The SQL
// text lives in `arg.strings`/`arg.values` (Prisma keeps both on the object),
// so this stand-in reconstructs the text and asserts on structure (FTS,
// ranking, facets, pagination) without a database.
interface RawCall {
  sql: string;
  values: unknown[];
}

interface MockResponse {
  rows?: unknown[];
  count?: number;
}

class FakePrisma {
  rawCalls: RawCall[] = [];
  $queryRaw = vi.fn(async (arg: unknown) => {
    const { sql, values } = extractSql(arg);
    this.rawCalls.push({ sql, values });
    return [];
  });
  creator = {
    findMany: vi.fn(async () => []),
  };
  searchQuery = {
    upsert: vi.fn(async () => ({})),
    findMany: vi.fn(async () => []),
  };
}

/**
 * Flattens a Prisma `Sql` value into { sql, values }. `Sql` nests composed
 * fragments (`Prisma.join`, nested `Prisma.sql`) as values of its parent, so
 * gluing the top-level literals with their (nested) values reproduces the
 * final statement text closely enough for structural assertions.
 */
function extractSql(arg: unknown): { sql: string; values: unknown[] } {
  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlObj = arg as { strings: string[]; values: unknown[] };
    const values: unknown[] = [];
    const render = (obj: { strings: string[]; values: unknown[] }): string =>
      obj.strings.reduce((acc, s, i) => {
        if (i >= obj.values.length) return acc + s;
        const v = obj.values[i];
        if (v && typeof v === 'object' && 'strings' in (v as object)) {
          values.push(...((v as { values: unknown[] }).values ?? []));
          return acc + s + render(v as { strings: string[]; values: unknown[] });
        }
        values.push(v);
        return acc + s + `$${i + 1}`;
      }, '');
    return { sql: render(sqlObj), values };
  }
  return { sql: String(arg), values: [] };
}

/**
 * Builds a `$queryRaw` mock that resolves a distinct response per sequential
 * call and records the reconstructed SQL of each invocation. A response with
 * `count` becomes a `[{ count }]` row; `rows` is returned as-is.
 */
function mockQueryRaw(prisma: FakePrisma, responses: MockResponse[]): void {
  let call = 0;
  prisma.$queryRaw = vi.fn(async (arg: unknown) => {
    const index = call++;
    const { sql } = extractSql(arg);
    prisma.rawCalls.push({ sql, values: extractSql(arg).values });
    const resolved = responses[index];
    if (!resolved) {
      return Promise.reject(new Error(`No mock response for query call #${index}; SQL: ${sql}`));
    }
    if (resolved.count !== undefined) {
      return Promise.resolve([{ count: resolved.count }]);
    }
    return Promise.resolve(resolved.rows ?? []);
  });
}

function getSql(prisma: FakePrisma, callIndex: number): string {
  return prisma.rawCalls[callIndex]?.sql ?? '';
}

describe('SearchService.search', () => {
  let prisma: FakePrisma;
  let service: SearchService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new SearchService(prisma as never);
  });

  it('always scopes results to public creators', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'cat' });
    expect(getSql(prisma, 0)).toContain('"isPublic" = true');
  });

  it('uses PostgreSQL full-text search with websearch_to_tsquery', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'portrait artist' });
    expect(getSql(prisma, 0)).toContain('"tsv" @@ websearch_to_tsquery');
  });

  it('filters by category when provided', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'art', category: 'music' });
    expect(getSql(prisma, 0)).toContain('"category" = $');
  });

  it('filters by tag when provided', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'art', tag: 'sketching' });
    expect(getSql(prisma, 0)).toContain('"tags" && ARRAY[');
  });

  it('filters by verified flag when provided', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'art', verified: true });
    expect(getSql(prisma, 0)).toContain('"verified" = $');
  });

  it('ranks verified creators before unverified, then by followers', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    // Unique term per test: the service-level cache is module-scoped, so a
    // repeated filter set would serve the previous test's cached result.
    await service.search({ q: 'unique-ranking-term' });
    const sql = getSql(prisma, 0);
    const orderIndex = sql.indexOf('ORDER BY');
    const orderBy = sql.slice(orderIndex);
    expect(orderBy).toContain('"verified" DESC');
    expect(orderBy).toContain('"followerCount" DESC');
    expect(orderBy).toContain('"rank" DESC');
  });

  it('applies pagination LIMIT and OFFSET', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'cat', page: 2, pageSize: 10 });
    expect(getSql(prisma, 0)).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
  });

  it('returns items mapped with relevance scores', async () => {
    mockQueryRaw(prisma, [
      {
        rows: [
          {
            id: 'c1',
            userId: 'u1',
            username: 'alice',
            displayName: 'Alice',
            bio: null,
            avatar: null,
            verified: true,
            followerCount: 100,
            category: 'art',
            tags: ['painting'],
            rank: 0.42,
          },
        ],
      },
      { count: 1 },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
    const result = await service.search({ q: 'alice' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'c1',
      username: 'alice',
      verified: true,
      followerCount: 100,
      relevance: 0.42,
    });
  });

  it('returns paginated metadata and facets', async () => {
    mockQueryRaw(prisma, [
      { rows: [] },
      { count: 7 },
      { rows: [{ value: 'art', count: 3 }] },
      { rows: [{ value: 'sketching', count: 5 }] },
      { rows: [{ value: true, count: 4 }] },
    ]);
    const result = await service.search({ q: 'unique-facet-term', page: 1, pageSize: 20 });
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
    expect(result.facets.categories).toEqual([{ value: 'art', count: 3 }]);
    expect(result.facets.tags).toEqual([{ value: 'sketching', count: 5 }]);
    expect(result.facets.verified).toEqual([{ value: true, count: 4 }]);
  });

  it('omits the selected dimension from its own facet counts', async () => {
    mockQueryRaw(prisma, [{ rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] }]);
    await service.search({ q: 'art', category: 'music', tag: 'piano', verified: true });
    // Facet queries run after result + count: indexes 2..4
    expect(getSql(prisma, 2)).not.toContain('"category" = $');
    expect(getSql(prisma, 3)).not.toContain('"tags" && ARRAY[');
    expect(getSql(prisma, 4)).not.toContain('"verified" = $');
    // But the other facet queries keep their filters
    expect(getSql(prisma, 2)).toContain('"tags" && ARRAY[');
    expect(getSql(prisma, 3)).toContain('"category" = $');
  });

  it('validates pagination before touching the database', async () => {
    // pageSize out of bounds must throw a validation error before any query
    mockQueryRaw(prisma, []);
    await expect(service.search({ q: 'x', pageSize: 1000 })).rejects.toThrow();
    expect(prisma.rawCalls).toHaveLength(0);
  });
});

describe('SearchService.analytics recording', () => {
  let prisma: FakePrisma;
  let service: SearchService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new SearchService(prisma as never);
  });

  function happyMocks(): void {
    mockQueryRaw(prisma, [
      { rows: [] },
      { count: 0 },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
  }

  it('upserts the normalized term into search analytics', async () => {
    happyMocks();
    await service.search({ q: '  Dog   CAT  ' });
    expect(prisma.searchQuery.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (prisma.searchQuery.upsert.mock.calls[0] as unknown as [
      { where: { term: string }; update: { count: { increment: number } } }
    ])[0];
    expect(upsertCall.where.term).toBe('dog cat');
    expect(upsertCall.update.count.increment).toBe(1);
  });

  it('records analytics on every uncached search execution', async () => {
    // Two distinct searches, five queries each.
    mockQueryRaw(prisma, [
      { rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [] }, { count: 0 }, { rows: [] }, { rows: [] }, { rows: [] },
    ]);
    await service.search({ q: 'dog cat' });
    await service.search({ q: 'fish bird' });
    expect(prisma.searchQuery.upsert).toHaveBeenCalledTimes(2);
  });

  it('skips recording terms shorter than 2 characters', async () => {
    happyMocks();
    await service.search({ q: 'a' });
    expect(prisma.searchQuery.upsert).not.toHaveBeenCalled();
  });

  it('skips recording when the query is blank', async () => {
    happyMocks();
    await service.search({ q: '   ' });
    expect(prisma.searchQuery.upsert).not.toHaveBeenCalled();
  });

  it('treats analytics failures as non-fatal', async () => {
    happyMocks();
    prisma.searchQuery.upsert = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(service.search({ q: 'quiet' })).resolves.toBeDefined();
    expect(prisma.searchQuery.upsert).toHaveBeenCalled();
  });
});

describe('SearchService.autocomplete', () => {
  let prisma: FakePrisma;
  let service: SearchService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new SearchService(prisma as never);
  });

  it('returns empty results for a blank query', async () => {
    const result = await service.autocomplete('   ');
    expect(result).toEqual({ creators: [], terms: [] });
    expect(prisma.creator.findMany).not.toHaveBeenCalled();
  });

  it('queries creators and popular terms in parallel', async () => {
    prisma.creator.findMany.mockResolvedValue([
      {
        id: 'c1',
        username: 'alice',
        displayName: 'Alice',
        avatar: null,
        verified: true,
      },
    ]);
    prisma.searchQuery.findMany.mockResolvedValue([{ term: 'alice art', count: 12 }]);

    const result = await service.autocomplete('ali');

    expect(prisma.creator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isPublic: true,
          OR: expect.any(Array),
        }),
        take: expect.any(Number),
      })
    );
    expect(prisma.searchQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { term: { startsWith: 'ali' } },
        orderBy: { count: 'desc' },
      })
    );
    expect(result.creators).toHaveLength(1);
    expect(result.terms).toEqual([{ term: 'alice art', count: 12 }]);
  });

  it('serves autocomplete from cache on repeat queries', async () => {
    prisma.creator.findMany.mockResolvedValue([]);
    prisma.searchQuery.findMany.mockResolvedValue([]);

    // Unique prefix: an earlier test already cached 'ali'.
    const first = await service.autocomplete('zeta');
    const second = await service.autocomplete('zeta');

    expect(prisma.creator.findMany).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});

describe('SearchService.getTrendingSearches', () => {
  let prisma: FakePrisma;
  let service: SearchService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new SearchService(prisma as never);
  });

  it('clamps limit into the 1..50 range and orders by count', async () => {
    prisma.searchQuery.findMany.mockResolvedValue([]);
    await service.getTrendingSearches(500);
    expect(prisma.searchQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { count: 'desc' },
        take: 50,
      })
    );
  });

  it('returns trending terms from the analytics table', async () => {
    prisma.searchQuery.findMany.mockResolvedValue([
      { term: 'art', count: 100, lastSearchedAt: new Date() },
    ]);
    const result = await service.getTrendingSearches(5);
    expect(result).toHaveLength(1);
    expect(result[0].term).toBe('art');
  });
});
