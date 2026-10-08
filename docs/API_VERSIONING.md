# API versioning and migration

Dorisio uses URL path versioning: `/api/v1/...` and `/api/v2/...`. Both versions are supported concurrently. Clients may also send `API-Version: 1|2` or `Accept: application/vnd.dorisio.v2+json`; conflicting selectors return `400 CONFLICTING_API_VERSION`.

## Deprecation

Deprecated handlers use `Deprecation: true`, an RFC 8594 `Sunset` date, and a `Link: <...>; rel="deprecation"` migration link. A deprecated version remains supported for at least 12 months after the deprecation date. Version usage is exported as `dorisio_api_version_requests_total{version,path}`.

## v1 to v2 migration

1. Keep existing `/api/v1` clients unchanged while adding v2 support.
2. Opt into v2 per request using `/api/v2` or the media type above.
3. Compare response contracts in the OpenAPI document at `/docs`.
4. Migrate endpoint-by-endpoint; monitor the version metric and only schedule v1 sunset after usage is zero or an approved exception list is complete.

## Cache and database rollout

Cache TTLs are tips/analytics 5 minutes, creators 10 minutes, and earnings 1 minute. Mutations publish invalidation events through Redis and every instance applies local DEL operations. Read replicas are opt-in per query (`readReplica: true`), health checked against the configured lag tolerance (5 seconds by default), and automatically fall back to primary on failure.
