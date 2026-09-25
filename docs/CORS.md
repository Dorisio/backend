# CORS & Security Headers

Issue #28.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:5173` | Comma-separated allow-list. Use `*` only in local/dev. |
| `CORS_CREDENTIALS` | `true` | Reflect `Access-Control-Allow-Credentials`. |
| `CORS_MAX_AGE` | `86400` | Preflight cache (seconds). |

Implemented in `src/plugins/security.ts` via `@fastify/cors` + `@fastify/helmet`.

## Headers

- **CSP** (production): `default-src 'self'`; `frame-ancestors 'none'`
- **X-Frame-Options**: `DENY` (clickjacking)
- **X-Content-Type-Options**: `nosniff`
- **Referrer-Policy**: `no-referrer`
- **HSTS**: enabled in production (`max-age=31536000; includeSubDomains; preload`)

## Preflight rate limiting

`OPTIONS` requests are limited to **60/IP/minute** to reduce preflight abuse.

## Allowed methods / headers

- Methods: `GET, POST, PUT, DELETE, PATCH, OPTIONS`
- Request headers: `Content-Type, Authorization, X-Requested-With`
