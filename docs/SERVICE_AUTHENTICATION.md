# Service-to-Service Authentication

Internal callers use a dedicated API-key guard, separate from user JWT authentication:

```ts
import { requireServiceScope, requireServiceRole } from '../middleware/service-auth';

app.get('/internal/users', { preHandler: requireServiceScope('users:read') }, handler);
app.post('/internal/jobs', { preHandler: requireServiceRole('worker') }, handler);
```

## Credential model

`INTERNAL_SERVICE_API_KEYS` is injected as JSON and may contain `id`, `serviceId`, `key` or `currentKey`, `scopes`, `roles`, `expiresAt`, and `previousKeys`. API keys are never attached to request context or audit records. The request receives only `request.service`: `{ id, scopes, roles, keyVersion, expiresAt, mtls }`. Current and previous candidates are compared using SHA-256 digests and `timingSafeEqual`; all configured records are examined before a decision. Missing, malformed, disabled, invalid, and expired credentials fail closed with a generic 401 response. Successful authentication followed by a scope/role denial returns 403.

## Rotation

Rotate every quarter or sooner after suspected exposure:

1. Generate a new high-entropy key and add it as `key`/`currentKey`.
2. Move the old key to `previousKeys` with an explicit, short `expiresAt` overlap.
3. Roll out configuration and update all callers.
4. Confirm logs show only service identity, key id/version, and decision metadata.
5. Remove the previous key after overlap expiry and verify old callers fail.

Use a secrets manager or process environment injection. Do not put real keys in `.env.example`, Git, tickets, traces, metrics, or error details.

## mTLS and proxies

Set `INTERNAL_SERVICE_MTLS_ENABLED=true` to require `request.raw.socket` to be encrypted, authorized by Node TLS, and to expose a peer certificate. Optional fingerprint/CN allowlists further restrict the peer. Arbitrary `X-Client-Cert`, `Forwarded`, or similar headers are ignored. If a reverse proxy terminates TLS, it must validate the client certificate and use a private, authenticated hop to the API; do not claim end-to-end mTLS at the application unless the API receives the verified TLS socket (TLS passthrough or equivalent).

Internal service routes are classified separately for rate limiting and bucketed by service identity when available, otherwise by a SHA-256 hash of the presented key.

## User JWT Authentication

User authentication uses short-lived access tokens and long-lived refresh tokens issued by `src/domains/auth/auth.service.ts` and validated by `src/middleware/auth.ts`.

### Token lifecycle

1. **Login** — `AuthService.login` issues an access token (JWT, short expiry from `JWT_EXPIRES_IN`) and a refresh token (JWT, longer expiry from `JWT_REFRESH_EXPIRES_IN`). Both carry a unique JTI and the user's current `authVersion`.
2. **Access token validation** — `authMiddleware` verifies the JWT signature and expiry via `verifyToken`, checks the token is not blacklisted (`isTokenBlacklisted`), and confirms the token's `authVersion` matches the user's current `authVersion` (`isUserAuthVersionCurrent`). Mismatch or blacklist returns 401.
3. **Refresh token rotation** — `AuthService.refreshAccessToken` verifies the refresh token (`verifyRefreshToken`), rejects it if blacklisted (`isRefreshTokenBlacklisted`) or if its `authVersion` is stale, then blacklists the old JTI and issues a new access/refresh token pair with a fresh JTI. The old refresh token can never be used again.
4. **Logout** — the access token is blacklisted (`blacklistToken`) for its remaining lifetime and the refresh cookie is cleared.
5. **Password reset / session revoke-all** — increments the user's `authVersion`, invalidating every outstanding JWT issued under the previous version.
6. **Blacklist cleanup** — `cleanupExpiredTokens` runs hourly (and on startup) to delete expired `blacklistedToken` and `passwordResetToken` rows from the database and evict them from the in-memory cache.

### Refresh token rotation

Each successful refresh call issues a new access/refresh token pair and blacklists the previous refresh token JTI. A revoked refresh token returns 401 Unauthorized and cannot be reused. Per-session `authVersion` on the User model prevents replay of tokens issued before a password change or session revocation.

### Expiry validation

Access and refresh tokens embed standard `exp` claims. `jwt.verify` rejects any token whose `exp` has passed; there is no grace period. Expired tokens are purged from the blacklist automatically by the periodic cleanup job.
