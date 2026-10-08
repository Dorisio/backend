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
