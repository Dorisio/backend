# Rate Limiting

Every HTTP route is rate limited by a single, centrally configured middleware
built on [`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit).
Routes never declare their own limits: each route is assigned a **route class**
when it is registered, and the class decides the limit.

| File | Purpose |
| --- | --- |
| `src/config/rate-limit.ts` | Policies per class, exemptions, classification rules. **The only file you edit to change limits.** |
| `src/plugins/rateLimit.ts` | Classifies routes and wires `@fastify/rate-limit`; resolves the client key. |
| `src/middleware/auth-guards.ts` | Registry of auth hooks, used to detect authenticated routes. |
| `src/plugins/__tests__/rateLimit.test.ts` | Tests. |

## Route classes and default limits

| Class | Default limit | Env overrides | Used for |
| --- | --- | --- | --- |
| `public` | 100 requests / 60 s | `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_PUBLIC_WINDOW_MS` | Unauthenticated reads (creator profiles, lookups, ...) |
| `authenticated` | 300 requests / 60 s | `RATE_LIMIT_AUTHENTICATED_MAX`, `RATE_LIMIT_AUTHENTICATED_WINDOW_MS` | Routes guarded by `authMiddleware` / `requireAdmin` / `requireCreator` |
| `sensitive` | 10 requests / 60 s | `RATE_LIMIT_SENSITIVE_MAX`, `RATE_LIMIT_SENSITIVE_WINDOW_MS` | Credentials, wallet signatures, money movement, expensive operations |
| _exempt_ | no limit | none | Health/readiness probes, CORS preflight |

Limits are counted **per client, per route**: a client that has used up its
quota on `POST /api/v1/auth/login` can still call `GET /api/v1/creators/:id`,
and two `public` routes have separate counters.

## How a route is classified

Classification happens once, when the route is registered (an `onRoute`
hook), by matching the route's method and **URL pattern** (e.g.
`/api/v1/wallet/:walletId/balance`, not a concrete path):

1. **Exemptions** (`RATE_LIMIT_EXEMPTIONS`): if one matches, the route gets
   no rate-limit hook at all.
2. **Rules** (`RATE_LIMIT_RULES`): the first matching rule sets the class.
3. **Automatic**: `authenticated` if the route runs a registered auth guard in
   `onRequest`/`preParsing`/`preValidation`/`preHandler`, otherwise `public`.

`HEAD` routes are classified like their `GET` counterpart. A route registered
for several methods gets the strictest class among them.

Matchers take an optional `method` (string or array; omitted = any method) and a
`url`, which may be an exact pattern, a prefix ending in `/*`
(`/api/v1/jobs/*` matches `/api/v1/jobs` and everything below it), or `*`.

### Classify a new route

Usually you don't need to do anything. A route with `preHandler: authMiddleware`
(or `requireAdmin`, `requireCreator`, `requireRole(...)`) is `authenticated`
and any other route is `public`.

If the route is sensitive or expensive, add a rule to `RATE_LIMIT_RULES` in
`src/config/rate-limit.ts`:

```ts
{ method: 'POST', url: '/api/v1/creators/:id/avatar', class: 'sensitive' },
```

If you write a new authentication hook, register it so authenticated routes are
detected:

```ts
import { registerAuthGuard } from '../middleware/auth-guards';
export const apiKeyAuth = registerAuthGuard(async (request, reply) => { ... });
```

Do **not** set `config.rateLimit` on a route. The plugin rejects it at startup
so limits cannot drift away from the central config.

### Add an exemption

Add a matcher to `RATE_LIMIT_EXEMPTIONS`:

```ts
{ method: 'GET', url: '/api/v1/jobs/health' },
```

Exempt routes are skipped entirely: no counter, no rate-limit headers. Keep this
list to endpoints that must never be throttled (orchestrator probes).

### Add a new class

Add it to the `RateLimitClass` union and to `RATE_LIMIT_POLICIES` (plus env
vars in `src/config/env.ts` if it should be tunable per environment), then
reference it from rules.

## Client identification

Each request is counted against one key:

- `user:<userId>` when the `Authorization: Bearer` token has a valid signature
  and has not expired. The limiter runs in `onRequest`, before the route's auth
  `preHandler`, so it verifies the token itself using the same `JWT_SECRET`.
  Forged or expired tokens fall back to the IP and cannot claim someone
  else's bucket. Revocation is not checked here; `authMiddleware` still
  rejects revoked tokens.
- `ip:<request.ip>` otherwise.

The app has no API-key authentication yet. When it gets one, extend
`resolveClientKey` in `src/plugins/rateLimit.ts`.

## Running behind a reverse proxy

Fastify only derives `request.ip` from `X-Forwarded-For` when `trustProxy` is
set, and the server sets it from `TRUST_PROXY`:

| `TRUST_PROXY` | Effect |
| --- | --- |
| `false` (default) | Forwarded headers are ignored; `request.ip` is the TCP peer. Use this when clients connect directly. |
| `1` (hop count) | Trust one proxy: the client is the right-most `X-Forwarded-For` entry. Use this behind a single load balancer. |
| `10.0.0.0/8,127.0.0.1` | Trust only these proxy addresses/CIDRs. This is the safest choice when the proxy address range is known. |
| `true` | Trust everything: the client is the **left-most** entry, which clients can forge to evade limits. Avoid; it triggers a startup configuration warning (below). |

If this is wrong behind a proxy, every user shares the proxy's IP and one
bucket. If it's too permissive, clients can spoof their IP.

### Startup configuration warnings

`TRUST_PROXY=true` and `RATE_LIMIT_ENABLED=false` are reported on boot by
`src/config/warnings.ts`. Each warning is logged as one entry, followed by a
summary:

```json
{"level":40,"configWarning":true,"setting":"TRUST_PROXY","msg":"Configuration warning [TRUST_PROXY]: ..."}
{"level":40,"configWarning":true,"count":1,"settings":["TRUST_PROXY"],"msg":"1 configuration warning(s) at startup, ..."}
```

Entries are logged at `warn`. If `LOG_LEVEL` is `error` or `fatal`, they are
logged at that level instead, so they are never filtered out. Alert on
`configWarning: true`. Add new unsafe-setting checks to
`collectConfigWarnings`.

## Responses

Every rate-limited response carries:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 37        # seconds until the window resets
```

When the limit is exceeded the server returns **429** with the same headers plus
`Retry-After` (seconds), and the standard error envelope:

```json
{
  "success": false,
  "error": {
    "message": "Too many requests, please try again later",
    "code": "RATE_LIMIT_EXCEEDED",
    "details": { "policy": "public", "limit": 100, "windowMs": 60000, "retryAfterSeconds": 37 }
  },
  "timestamp": "..."
}
```

The message is localized from `Accept-Language` like other errors. The headers
are listed in CORS `exposedHeaders`, so browser clients can read them.

## Storage and multiple instances

`RATE_LIMIT_STORE=memory` (default) keeps counters in process. With several API
instances each instance counts separately, so the effective limit is multiplied
by the instance count. Set `RATE_LIMIT_STORE=redis` to share counters through
`REDIS_URL`. If Redis is unreachable, requests are allowed through rather than
failed.

Set `RATE_LIMIT_ENABLED=false` to turn rate limiting off, e.g. for load tests.

## Related limiters

These are separate and intentionally left in place:

- `rateLimitTipCreation` (`src/middleware/rate-limit.ts`): a business quota
  of 10 tips per user per hour, stacked on top of the `sensitive` class.
- `rateLimitCorsPreflight` (`src/plugins/security.ts`): limits CORS
  preflight requests, which is why `OPTIONS` is exempt here.
- `failure-limiter` (`src/lib/failure-limiter.ts`): throttles clients that
  repeatedly send invalid input.
