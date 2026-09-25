# Query Performance

Issue #12. Companion document to [INDEXING.md](./INDEXING.md) (index layout) and
[PAGINATION.md](./PAGINATION.md) (result-size limits).

## What is instrumented

### Prisma (the ORM)

`src/db/prisma-performance.ts` wraps the client in a Prisma query extension
(`$extends`) that is installed once, in `src/index.ts`:

```ts
const { client, monitor } = createInstrumentedPrismaClient();
```

Every operation — reads and writes, on every model — then records:

| Signal | Where it goes |
|--------|---------------|
| duration, per `Model.operation` | `dorisio_prisma_query_duration_seconds` histogram, `PrismaPerformanceMonitor.getStats()` |
| call/error counts | `dorisio_prisma_query_count_total`, `stats.operations[key].errors` |
| rows returned | `dorisio_prisma_query_rows` histogram |
| slow queries | `dorisio_prisma_slow_queries_total`, `monitor.getSlowQueries()` |
| read-cache hits/misses | `dorisio_prisma_cache_hits_total` / `dorisio_prisma_cache_misses_total` |
| list reads without `take` | `dorisio_prisma_unbounded_reads_total` |

Because the extension is a client-level concern rather than a service concern,
new code gets instrumentation without having to remember it.

### Raw SQL (`pg` pool)

`src/db/connection.ts` keeps a separate `pg` pool. Its `query()` helper goes
through `QueryCache` + `QueryLogger` (`src/db/query-cache.ts`,
`src/db/query-logger.ts`) with the same guarantees: statements are fingerprinted
by `normalizeSql()` (literals → placeholders) so metrics and slow-query grouping
stay at constant cardinality, and parameters are redacted and truncated before
they reach a log line.

## Read cache

Short-lived, deliberately conservative:

| Setting | Env var | Default |
|---------|---------|---------|
| enabled | `DB_QUERY_CACHE_ENABLED` | `true` |
| TTL | `DB_QUERY_CACHE_TTL_MS` | `60000` |
| hard TTL ceiling | `DB_QUERY_CACHE_MAX_TTL_MS` | `300000` |
| max entries | `DB_QUERY_CACHE_MAX_ENTRIES` | `500` |

Rules the implementation enforces:

1. **Writes are never cached** — only `findUnique`, `findFirst`, `findMany`,
   `count`, `aggregate` and `groupBy` are eligible, and the raw-SQL path refuses
   anything that is not read-only (`isReadOnlyQuery()`).
2. **A write invalidates the whole model** (`model:Tip` → drop every cached
   `Tip.*` read) in a `finally`, so a failed write cannot leave stale rows
   cached either.
3. **Projections that touch credentials or signing material are never cached**
   (`password`, `secretKey`, `apiKey`, … at any nesting depth) — the process
   cache must not become a credential store.
4. **A cached `null` is a hit, not a miss.** `lookup()`/`peek()` return
   `{ hit, value }` so "no rows" is not re-queried on every request.
5. **Single-flight**: concurrent misses for one key share one loader
   (`getOrLoad`), so a cold cache does not turn into a thundering herd.
6. **TTL is clamped** to the configured maximum, whatever a caller asks for.

## Unbounded and N+1 reads

* List reads without `take` are counted and warned about (throttled to one log
  line per minute per model) by the monitor — the query still runs, so this is a
  signal, not a hard failure.
* Hot paths were converted to bounded reads:
  * `getTopCreators` / `getTopSupporters` use `groupBy` + `take` + an aggregate
    instead of loading rows to sort them in Node.
  * Earnings-over-time is bucketed with `date_trunc` in SQL
    (`$queryRaw`) instead of fetching every tip.
  * `listWebhooks` is paginated; webhook dispatch fans out over at most
    `MAX_DISPATCH_TARGETS = 50` targets per event.
  * Wallet reads are projected and capped at 20 rows per user.
* Full-table `findMany` followed by arithmetic in JS became `aggregate`
  (`_sum`/`_count`) in `creators/analytics.service.ts`.

## N+1 sweep

Every remaining `findMany` in `src/` is paginated, capped or a bounded
per-parent lookup, and relation payloads use `select` instead of `include` where
only a few columns are needed (`TIP_RESPONSE_SELECT`, `WEBHOOK_EVENT_SELECT`,
`CREATOR_PROFILE_SELECT`, `USER_PROFILE_SELECT`, `CREATOR_SELECT`,
`TIP_SELECT`, `USER_SELECT`).

One loop that remains is intentional: webhook dispatch `Promise.all`s over the
event's targets. It is bounded, and the targets are needed independently.

## Projections

List and detail reads project only the fields the API returns. Notable
consequence: `WebhookEvent` reads exclude `payload`, which is the largest column
in the table and is only needed by the delivery worker.

## Diagnostics endpoints

```
GET  /diagnostics/queries/performance   # aggregated stats + recent slow queries
POST /diagnostics/queries/explain       # EXPLAIN (FORMAT JSON) for a SELECT
```

The explain endpoint validates its body with Zod and rejects anything that is not
read-only before it reaches the database:

```bash
curl -s -X POST localhost:3000/diagnostics/queries/explain \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM \"Tip\" WHERE \"creatorId\" = $1","params":["<id>"],"buffers":true}'
```

`{"analyze": true}` prefixes the statement with `EXPLAIN ANALYZE`, which
**executes** it — that is why it is opt-in.

Both endpoints, plus the `query_performance` block in `GET /health` and
`GET /metrics/json`, read the shared monitor. If a cache ever needs to be
invalidated by hand, `POST /cache/invalidate` still works as before.

## Slow-query triage

1. `GET /metrics/json` → `query_performance` (per-operation p99-ish max, error
   counts, cache hit rate, unbounded reads).
2. `GET /diagnostics/queries/performance` → `slowQueries[]`, newest first, with
   fingerprint, duration, row count and timestamp.
3. Reproduce the fingerprint with `POST /diagnostics/queries/explain` and read
   `indexNames` / `sequentialScans` / `recommendations`.
4. If a recommendation is "row estimates differ significantly", run
   `ANALYZE` on the table — the new migration already runs `ANALYZE` for the
   tables it touches, but statistics drift as data grows.
5. If a query is hot but legitimately read-mostly, raise `DB_QUERY_CACHE_TTL_MS`
   before reaching for a replica.

Threshold: `DB_SLOW_QUERY_THRESHOLD_MS` (default 200). A statement at or above
it is logged at `warn` and kept in the in-memory history (100 entries, ring
buffer).
