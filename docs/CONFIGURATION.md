# Configuration Reference

Every environment variable the application reads is declared, validated and
documented here. This is the companion to `src/config/schema.ts` — a test
(`src/config/__tests__/config.test.ts`) fails when a schema key is missing
from this file, so the reference cannot silently rot.

For a quick-start template see [`.env.example`](../.env.example).

## How configuration is loaded

Layering, lowest → highest precedence (later wins):

| Layer                  | Source                                                                | Notes                                                                 |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. Schema defaults     | `src/config/schema.ts`                                                | Safe values for every key; nothing is required to boot in development |
| 2. Environment file    | `.env.development` / `.env.staging` / `.env.production` / `.env.test` | Selected by `NODE_ENV`; committed, placeholders only                  |
| 3. Machine overrides   | `.env`, `.env.local`                                                  | Git-ignored; your real local secrets                                  |
| 4. Process environment | actual environment variables                                          | Docker/Kubernetes/CI — always wins                                    |

**Fail fast:** configuration is validated with the Zod schema
(`EnvSchema`) exactly once at startup. Missing keys, wrong types,
out-of-range values, unresolvable secret references and production-only
guards abort the process with a list of _all_ problems before the HTTP
listener opens. Hot reloads re-run the same validation and are atomic: an
invalid candidate leaves the previous snapshot in place.

## Secret references

Secret values may be written as `{{ SECRET_NAME }}`:

```bash
JWT_SECRET={{ JWT_SECRET }}        # resolved from the process environment
DATABASE_URL={{ DATABASE_URL }}    # or an injected secrets provider
```

- Resolution order: process environment → optional `secretsProvider` map.
  Production Kubernetes uses External Secrets Operator with AWS Secrets
  Manager; see the [secret rotation runbook](runbooks/secrets.md).
- An unresolved reference is a **startup failure**, never a literal
  `{{ ... }}` string reaching the application.
- Secret values are redacted as `[REDACTED]` in the config audit log and in
  validation error output.

## Conventions used in the tables

- **Secret** — value is a credential; redacted in logs/audit.
- **Hot reload** — picked up by `reloadConfig()`; critical keys (marked ✖)
  are pinned at boot and require a process restart (open connections hold the
  old credential).
- Ranges are inclusive. Durations are `<number><s|m|h|d>` (e.g. `15m`, `7d`).
- Booleans accept `true/1/yes/on` and `false/0/no/off`, case-insensitive.

---

## Server

| Variable                       | Type   | Default             | Range/Values                                  | Secret | Hot reload | Description                                                |
| ------------------------------ | ------ | ------------------- | --------------------------------------------- | ------ | ---------- | ---------------------------------------------------------- |
| `NODE_ENV`                     | enum   | `development`       | `development` `staging` `production` `test`   | no     | ✖         | Selects the environment file and enables production guards |
| `PORT`                         | int    | `3000`              | 1–65535                                       | no     | ✖         | HTTP listen port                                           |
| `HTTP2_ENABLED`                | bool   | `false`             | —                                             | no     | ✖         | Enable HTTP/2 listener                                     |
| `RESPONSE_COMPRESSION_ENABLED` | bool   | `true`              | —                                             | no     | ✅         | Enable response compression                                |
| `RESPONSE_CACHE_CONTROL`       | string | `private, no-cache` | —                                             | no     | ✅         | Default cache-control header                               |
| `LOG_LEVEL`                    | enum   | `info`              | `trace` `debug` `info` `warn` `error` `fatal` | no     | ✅         | Pino log level                                             |
| `SHUTDOWN_TIMEOUT_MS`          | int    | `30000`             | 1000–300000                                   | no     | ✅         | Graceful-shutdown drain window (#23)                       |
| `API_HOST`                     | string | —                   | hostname                                      | no     | ✅         | Swagger server host; empty = localhost                     |

## Database

| Variable                             | Type   | Default                               | Range/Values                                                   | Secret  | Hot reload | Description                                                            |
| ------------------------------------ | ------ | ------------------------------------- | -------------------------------------------------------------- | ------- | ---------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                       | string | —                                     | PostgreSQL connection string                                   | **yes** | ✖         | Postgres connection string; **required in production/staging**         |
| `DB_POOL_MIN`                        | int    | `2`                                   | 1–100                                                          | no      | ✖         | Minimum pool connections                                               |
| `DB_POOL_MAX`                        | int    | `20`                                  | 1–100 (≥ `DB_POOL_MIN`)                                        | no      | ✖         | Maximum pool connections                                               |
| `DB_CONNECTION_TIMEOUT_MS`           | int    | `5000`                                | 100–60000                                                      | no      | ✅         | Connect timeout                                                        |
| `DB_IDLE_TIMEOUT_MS`                 | int    | `30000`                               | 0–300000                                                       | no      | ✅         | Idle client teardown                                                   |
| `DB_MAX_LIFETIME_MS`                 | int    | `1800000`                             | 1000–3600000                                                   | no      | ✅         | Max connection lifetime                                                |
| `DB_STATEMENT_TIMEOUT_MS`            | int    | `10000`                               | 0–600000                                                       | no      | ✅         | Per-statement server timeout                                           |
| `DB_SLOW_QUERY_THRESHOLD_MS`         | int    | `200`                                 | 1–60000                                                        | no      | ✅         | Slow-query log threshold (#12)                                         |
| `DB_LOG_QUERIES`                     | bool   | `false`                               | —                                                              | no      | ✅         | Log every SQL statement (development only)                             |
| `DB_QUERY_CACHE_ENABLED`             | bool   | `true`                                | —                                                              | no      | ✅         | Read-query result cache (#12)                                          |
| `DB_QUERY_CACHE_TTL_MS`              | int    | `60000`                               | 1000–300000                                                    | no      | ✅         | Default cache TTL                                                      |
| `DB_QUERY_CACHE_MAX_TTL_MS`          | int    | `300000`                              | 1000–600000                                                    | no      | ✅         | Hard TTL upper bound                                                   |
| `DB_QUERY_CACHE_MAX_ENTRIES`         | int    | `1000`                                | 10–100000                                                      | no      | ✅         | Cache size limit                                                       |
| `DB_LEAK_DETECTION_TIMEOUT_MS`       | int    | `30000`                               | 1000–300000                                                    | no      | ✅         | Connection-leak detector                                               |
| `DB_CIRCUIT_BREAKER_FAILURES`        | int    | `5`                                   | 1–100                                                          | no      | ✅         | DB breaker trips after N failures                                      |
| `DB_CIRCUIT_BREAKER_RESET_MS`        | int    | `10000`                               | 100–600000                                                     | no      | ✅         | DB breaker reset timeout                                               |
| `DB_SSL_MODE`                        | enum   | `prefer`                              | `disable` `allow` `prefer` `require` `verify-ca` `verify-full` | no      | ✖         | PostgreSQL TLS mode; staging/production require certificate validation |
| `DB_SSL_REJECT_UNAUTHORIZED`         | bool   | `true`                                | —                                                              | no      | ✖         | Reject invalid PostgreSQL certificates                                 |
| `DB_SSL_CA`                          | string | —                                     | PEM text or mounted file path                                  | **yes** | ✖         | PostgreSQL CA certificate                                              |
| `DB_SSL_CERT`                        | string | —                                     | PEM text or mounted file path                                  | **yes** | ✖         | Optional client certificate                                            |
| `DB_SSL_KEY`                         | string | —                                     | PEM text or mounted file path                                  | **yes** | ✖         | Optional client private key                                            |
| `DB_SSL_SERVERNAME`                  | string | —                                     | TLS hostname                                                   | no      | ✖         | SNI/hostname used for certificate validation                           |
| `BACKUP_VERIFICATION_ENABLED`        | bool   | `false`                               | —                                                              | no      | ✅         | Enable the isolated encrypted-backup restore check                     |
| `BACKUP_VERIFICATION_CRON`           | string | `0 3 * * 0`                           | five-field cron                                                | no      | ✅         | Recommended weekly verification schedule                               |
| `BACKUP_VERIFICATION_TIMEOUT_MS`     | int    | `300000`                              | 1000–3600000                                                   | no      | ✅         | Overall verification timeout                                           |
| `BACKUP_VERIFICATION_MAX_RESTORE_MS` | int    | `120000`                              | 1000–3600000                                                   | no      | ✅         | Restore-time SLO                                                       |
| `BACKUP_DIRECTORY`                   | string | `./private/backups`                   | directory                                                      | no      | ✖         | Primary encrypted-backup target                                        |
| `BACKUP_SECONDARY_DIRECTORY`         | string | `./private/backups-secondary`         | directory                                                      | no      | ✖         | Independent secondary backup target                                    |
| `BACKUP_ENCRYPTION_KEY`              | string | —                                     | 32-byte hex or base64                                          | **yes** | ✖         | AES-256-GCM backup key                                                 |
| `BACKUP_VERIFICATION_HISTORY_PATH`   | string | `./private/backup-verification.jsonl` | file path                                                      | no      | ✅         | Append-only verification history                                       |

## Circuit breakers (external services)

See `src/lib/circuit-breaker/` (issue #22).

| Variable                            | Type   | Default | Range/Values | Secret | Hot reload | Description                                                   |
| ----------------------------------- | ------ | ------- | ------------ | ------ | ---------- | ------------------------------------------------------------- |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | number | `0.5`   | 0–1          | no     | ✅         | Failure **rate** in the rolling window that trips the circuit |
| `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | int    | `2`     | 1–100        | no     | ✅         | Consecutive HALF_OPEN successes before closing                |
| `CIRCUIT_BREAKER_TIMEOUT_MS`        | int    | `60000` | 100–600000   | no     | ✅         | Per-call timeout; slower calls count as failures              |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`  | int    | `30000` | 100–600000   | no     | ✅         | OPEN duration before a HALF_OPEN trial                        |
| `CIRCUIT_BREAKER_MIN_REQUESTS`      | int    | `5`     | 1–1000       | no     | ✅         | Window size before the rate is evaluated                      |
| `CIRCUIT_BREAKER_ROLLING_WINDOW_MS` | int    | `60000` | 1000–3600000 | no     | ✅         | Rolling window length                                         |
| `CIRCUIT_BREAKER_VOLUME_THRESHOLD`  | int    | `5`     | 1–1000       | no     | ✅         | Warm-up guard: min volume before tripping                     |
| `STELLAR_CIRCUIT_BREAKER_ENABLED`   | bool   | `true`  | —            | no     | ✅         | Toggle the Stellar Horizon breaker                            |
| `WEBHOOK_CIRCUIT_BREAKER_ENABLED`   | bool   | `true`  | —            | no     | ✅         | Toggle the webhook dispatch breaker                           |

## Redis

| Variable                        | Type   | Default                  | Range/Values               | Secret  | Hot reload | Description                                                                         |
| ------------------------------- | ------ | ------------------------ | -------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------- |
| `REDIS_URL`                     | string | `redis://localhost:6379` | URL                        | no      | ✖         | Redis connection for pools, rate limiting, queues                                   |
| `REDIS_HOST`                    | string | —                        | hostname                   | no      | ✖         | Alternative to URL (used by `cacheConfig`)                                          |
| `REDIS_PORT`                    | int    | —                        | 1–65535                    | no      | ✖         | Alternative to URL (used by `cacheConfig`)                                          |
| `REDIS_PASSWORD`                | string | —                        | —                          | **yes** | ✖         | Alternative to URL (used by `cacheConfig`)                                          |
| `REDIS_DB`                      | int    | —                        | 0–15                       | no      | ✖         | Logical database index (used by `cacheConfig`)                                      |
| `REDIS_POOL_MIN`                | int    | `5`                      | 1–100                      | no      | ✅         | Connection pool minimum                                                             |
| `REDIS_POOL_MAX`                | int    | `20`                     | 1–200 (≥ `REDIS_POOL_MIN`) | no      | ✅         | Connection pool maximum                                                             |
| `REDIS_POOL_IDLE_TIMEOUT_MS`    | int    | `300000`                 | 0–3600000                  | no      | ✅         | Idle connection teardown                                                            |
| `REDIS_CONNECTION_TIMEOUT_MS`   | int    | `30000`                  | 1000–120000                | no      | ✅         | Connect/acquire timeout (pool acquire capped at 3s so Redis outages fall back fast) |
| `REDIS_HEALTHCHECK_INTERVAL_MS` | int    | `60000`                  | 1000–600000                | no      | ✅         | Background PING cadence                                                             |
| `CACHE_FALLBACK_MEMORY_SIZE`    | int    | `1000`                   | 1–100000                   | no      | ✅         | In-memory LRU fallback size when Redis is down                                      |
| `CACHE_WARMUP_ENABLED`          | bool   | `false`                  | —                          | no      | ✅         | Warm frequently-read data on boot                                                   |
| `CACHE_METRICS_ENABLED`         | bool   | `false`                  | —                          | no      | ✅         | Expose detailed cache metrics                                                       |
| `WARMUP_CACHE`                  | bool   | `false`                  | —                          | no      | ✅         | Legacy alias for cache warmup                                                       |
| `ENABLE_CACHE_METRICS`          | bool   | `false`                  | —                          | no      | ✅         | Legacy alias for cache metrics                                                      |

## Background jobs

| Variable               | Type | Default | Range/Values | Secret | Hot reload | Description                                                                              |
| ---------------------- | ---- | ------- | ------------ | ------ | ---------- | ---------------------------------------------------------------------------------------- |
| `JOBS_WORKERS_ENABLED` | bool | `false` | —            | no     | ✖         | Run the BullMQ worker pool inside the API process (prefer a dedicated worker deployment) |
| `ENABLE_WORKERS`       | bool | `false` | —            | no     | ✖         | Legacy alias for `JOBS_WORKERS_ENABLED`                                                  |
| `JOBS_CONCURRENCY`     | int  | `5`     | 1–64         | no     | ✅         | Concurrency for the generic jobs layer                                                   |
| `JOB_DEFAULT_ATTEMPTS` | int  | `3`     | 1–20         | no     | ✅         | Default attempts before the DLQ                                                          |
| `JOB_BACKOFF_MS`       | int  | `1000`  | 1–600000     | no     | ✅         | Base backoff delay                                                                       |
| `WORKER_CONCURRENCY`   | int  | `5`     | 1–64         | no     | ✅         | BullMQ worker concurrency (`src/lib/workers`)                                            |

## Auth / JWT

| Variable                 | Type     | Default         | Range/Values                                            | Secret  | Hot reload | Description            |
| ------------------------ | -------- | --------------- | ------------------------------------------------------- | ------- | ---------- | ---------------------- |
| `JWT_SECRET`             | string   | dev placeholder | ≥ 32 chars in production/staging (placeholder rejected) | **yes** | ✖         | Token signing secret   |
| `JWT_EXPIRES_IN`         | duration | `15m`           | `<n><s\|m\|h\|d>`                                       | no      | ✖         | Access-token lifetime  |
| `JWT_REFRESH_EXPIRES_IN` | duration | `7d`            | `<n><s\|m\|h\|d>`                                       | no      | ✖         | Refresh-token lifetime |

## Error tracking

| Variable                     | Type   | Default | Range/Values | Secret  | Hot reload | Description                 |
| ---------------------------- | ------ | ------- | ------------ | ------- | ---------- | --------------------------- |
| `SENTRY_DSN`                 | string | —       | DSN URL      | **yes** | ✅         | Sentry-compatible DSN       |
| `ERROR_TRACKING_ENABLED`     | bool   | `true`  | —            | no      | ✅         | Master toggle               |
| `ERROR_TRACKING_SAMPLE_RATE` | number | `1`     | 0–1          | no      | ✅         | Fraction of errors captured |
| `ERROR_TRACKING_TIMEOUT_MS`  | int    | `5000`  | 100–60000    | no      | ✅         | Transport timeout           |

## Stellar / Soroban

| Variable                     | Type   | Default                               | Range/Values                     | Secret  | Hot reload | Description                                                                              |
| ---------------------------- | ------ | ------------------------------------- | -------------------------------- | ------- | ---------- | ---------------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`            | enum   | `testnet`                             | `testnet` `mainnet` `standalone` | no      | ✖         | Target network                                                                           |
| `STELLAR_HORIZON_URL`        | string | `https://horizon-testnet.stellar.org` | URL                              | no      | ✖         | Horizon API base                                                                         |
| `STELLAR_HORIZON_TIMEOUT_MS` | int    | `60000`                               | 1000–600000                      | no      | ✅         | Per-request timeout                                                                      |
| `STELLAR_SERVER_SECRET_KEY`  | string | —                                     | Stellar secret key (S…)          | **yes** | ✖         | Server keypair for SEP-10 style wallet challenges; absent = wallet verification disabled |
| `USDC_CONTRACT_ID`           | string | —                                     | Contract ID                      | no      | ✖         | Soroban USDC contract                                                                    |
| `USDC_ISSUER`                | string | —                                     | Stellar public key (G…)          | no      | ✖         | USDC issuer account                                                                      |

## External payments

| Variable                             | Type   | Default                  | Range/Values    | Secret  | Hot reload | Description                          |
| ------------------------------------ | ------ | ------------------------ | --------------- | ------- | ---------- | ------------------------------------ |
| `PAYMENTS_PROVIDER`                  | enum   | `none`                   | `stripe` `none` | no      | ✖         | Active payment provider              |
| `STRIPE_SECRET_KEY`                  | string | —                        | —               | **yes** | ✖         | Stripe API key                       |
| `STRIPE_WEBHOOK_SECRET`              | string | —                        | —               | **yes** | ✖         | Stripe webhook HMAC secret           |
| `STRIPE_API_BASE`                    | string | `https://api.stripe.com` | URL             | no      | ✅         | Stripe API base (override for tests) |
| `PAYMENTS_WEBHOOK_TOLERANCE_SECONDS` | int    | `300`                    | 10–86400        | no      | ✅         | Webhook signature replay tolerance   |

## Domain limits

| Variable              | Type   | Default | Range/Values | Secret | Hot reload | Description                               |
| --------------------- | ------ | ------- | ------------ | ------ | ---------- | ----------------------------------------- |
| `WALLET_NONCE_EXPIRY` | int    | `600`   | 1–86400      | no     | ✅         | Wallet challenge nonce lifetime (seconds) |
| `MIN_PAYOUT_AMOUNT`   | number | `50`    | 0–1000000    | no     | ✅         | Minimum creator payout (USD)              |

## Email

| Variable                             | Type   | Default                            | Range/Values  | Secret  | Hot reload | Description                                       |
| ------------------------------------ | ------ | ---------------------------------- | ------------- | ------- | ---------- | ------------------------------------------------- |
| `FRONTEND_URL`                       | string | `http://localhost:3000`            | URL           | no      | ✅         | Base URL used in verification links               |
| `VERIFICATION_DOCUMENT_STORAGE_PATH` | string | `./private/verification-documents` | directory     | no      | ✖         | Private creator-verification document storage     |
| `SENDGRID_API_KEY`                   | string | —                                  | —             | **yes** | ✖         | SendGrid API key; absent = email skipped (logged) |
| `EMAIL_FROM`                         | email  | —                                  | valid address | no      | ✅         | From address                                      |

## HTTP surface (CORS / proxy)

| Variable           | Type   | Default | Range/Values                                      | Secret | Hot reload | Description                                                                 |
| ------------------ | ------ | ------- | ------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------------------- |
| `TRUST_PROXY`      | string | `false` | `false` \| hop count \| comma separated IPs/CIDRs | no     | ✖         | How `request.ip` is derived from X-Forwarded-For (avoid `true` — spoofable) |
| `CORS_ORIGINS`     | string | —       | `*` or comma separated origins                    | no     | ✅         | Browser origin allowlist (see `getCorsOrigins`)                             |
| `CORS_CREDENTIALS` | bool   | `true`  | —                                                 | no     | ✅         | `Access-Control-Allow-Credentials`                                          |
| `CORS_MAX_AGE`     | int    | `600`   | 0–86400                                           | no     | ✅         | Preflight cache (seconds)                                                   |

## Rate limiting

Policies and route classification live in `src/config/rate-limit.ts`
(docs: `docs/RATE_LIMITING.md`).

| Variable                             | Type | Default  | Range/Values     | Secret | Hot reload | Description                                                        |
| ------------------------------------ | ---- | -------- | ---------------- | ------ | ---------- | ------------------------------------------------------------------ |
| `RATE_LIMIT_ENABLED`                 | bool | `true`   | —                | no     | ✅         | Master toggle (disabled triggers a startup warning)                |
| `RATE_LIMIT_STORE`                   | enum | `memory` | `memory` `redis` | no     | ✅         | Counter store; use `redis` with >1 instance                        |
| `RATE_LIMIT_PUBLIC_MAX`              | int  | `100`    | 1–100000         | no     | ✅         | Max requests per public route per window                           |
| `RATE_LIMIT_PUBLIC_WINDOW_MS`        | int  | `60000`  | 1000–3600000     | no     | ✅         | Public route window                                                |
| `RATE_LIMIT_AUTHENTICATED_MAX`       | int  | `300`    | 1–100000         | no     | ✅         | Max requests per authenticated route per window                    |
| `RATE_LIMIT_AUTHENTICATED_WINDOW_MS` | int  | `60000`  | 1000–3600000     | no     | ✅         | Authenticated route window                                         |
| `RATE_LIMIT_SENSITIVE_MAX`           | int  | `10`     | 1–1000           | no     | ✅         | Max requests per sensitive route (login, tips, payouts) per window |
| `RATE_LIMIT_SENSITIVE_WINDOW_MS`     | int  | `60000`  | 1000–3600000     | no     | ✅         | Sensitive route window                                             |
| `RATE_LIMIT_INTERNAL_MAX`            | int  | `1000`   | 1–1000000        | no     | ✅         | Internal service route limit per service/key bucket                |
| `RATE_LIMIT_INTERNAL_WINDOW_MS`      | int  | `60000`  | 1000–3600000     | no     | ✅         | Internal service route window                                      |

## GraphQL

| Variable                 | Type | Default | Range/Values | Secret | Hot reload | Description                      |
| ------------------------ | ---- | ------- | ------------ | ------ | ---------- | -------------------------------- |
| `GRAPHQL_ENABLED`        | bool | `true`  | —            | no     | ✖          | Register the `/graphql` endpoint |
| `GRAPHQL_MAX_DEPTH`      | int  | `10`    | 1–100        | no     | ✅         | Query depth limit                |
| `GRAPHQL_MAX_COMPLEXITY` | int  | `1000`  | 1–100000     | no     | ✅         | Query complexity limit           |

## Feature flags

Resolved per environment by `src/config/features.ts`; the effective values
are folded into `config.FEATURE_*` and overridable per deployment with the
`FEATURE_*` variables below. Read them in code via
`isFeatureEnabled('<name>')`.

| Variable                     | Type | Default | Range/Values | Secret | Hot reload | Description                                                    |
| ---------------------------- | ---- | ------- | ------------ | ------ | ---------- | -------------------------------------------------------------- |
| `FEATURE_EMAIL_VERIFICATION` | bool | `true`  | —            | no     | ✅         | `emailVerification` — send/require the email verification flow |
| `FEATURE_ANALYTICS`          | bool | `true`  | —            | no     | ✅         | `analytics` — analytics rollup and routes                      |
| `FEATURE_WEBHOOKS`           | bool | `true`  | —            | no     | ✅         | `webhooks` — outbound webhook dispatch                         |
| `FEATURE_EXPORTS`            | bool | `true`  | —            | no     | ✅         | `exports` — background export jobs                             |
| `FEATURE_MAINTENANCE_MODE`   | bool | `false` | —            | no     | ✅         | `maintenanceMode` — reject non-admin traffic for drains        |

---

## Config audit log

Every load and hot reload appends redacted entries to an in-memory audit
trail (`src/config/audit.ts`, also exported from `src/config`):

```ts
import { getConfigAuditLog, getReloadAuditLog } from './config';
```

- Per-variable entries record `at`, `environment`, `key`, `value` (redacted
  for secrets), and `source` (`env-file` | `process-env`).
- Reload entries record `applied` (with changed keys) or `rejected` (with the
  validation issues) outcomes.
- Bounded at 500 entries (200 reload entries) so long-running processes don't
  accumulate unbounded state.

## Hot reload semantics

```ts
import { reloadConfig } from './config';
const next = reloadConfig(); // throws ConfigValidationError if invalid; atomic
```

- **Hot-reloadable** keys take effect on the next read of `config.X` for
  modules reading the live snapshot.
- **Pinned (✖) keys** — `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`,
  `JWT_*`, `STELLAR_*`, provider keys — deliberately do not silently rotate:
  open connections (DB pool, Redis, Horizon client) captured the old value at
  construction. The attempted change is still audited so operators can plan a
  restart.

## Operational recipes

```bash
# Local development
cp .env.example .env         # then edit real values (git-ignored)
pnpm dev

# Staging configuration locally
NODE_ENV=staging \
DATABASE_URL=postgres://... \
JWT_SECRET=$(openssl rand -hex 32) \
pnpm dev

# Override a single variable in Kubernetes
env:
  - name: RATE_LIMIT_PUBLIC_MAX
    value: "500"
```
