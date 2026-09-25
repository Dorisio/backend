# API Error Codes

Every error response returned by the Dorisio API uses one standardized envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request data is invalid",
    "details": {
      "issues": [{ "path": "amount", "message": "Number must be greater than 0", "code": "too_small" }]
    }
  },
  "timestamp": "2026-09-24T12:00:00.000Z"
}
```

- `code` — stable, machine readable identifier. **Branch on this value**, not on the message.
- `message` — human readable, sanitized. Never contains stack traces, SQL, or internal identifiers.
- `details` — optional structured context. Only present for operational (expected) errors.
- `timestamp` — server time in ISO 8601.

Stack traces are **never** returned to clients. Full error context (including the stack) is written to
the server logs and forwarded to the configured error tracker.

## HTTP status mappings

| Status | Meaning                                    |
| ------ | ------------------------------------------ |
| 400    | Bad request / validation failure           |
| 401    | Authentication missing or invalid          |
| 403    | Authenticated but not allowed              |
| 404    | Resource (or route) not found              |
| 409    | Conflict with current resource state       |
| 413    | Payload too large                          |
| 429    | Rate limit exceeded                        |
| 500    | Unexpected server error                    |
| 502    | Upstream/external service failure          |
| 503    | Service temporarily unavailable            |

## Core codes

| Code                  | Status | Description                                              |
| --------------------- | ------ | -------------------------------------------------------- |
| `VALIDATION_ERROR`    | 400    | Request body/query/params failed schema validation       |
| `BAD_REQUEST`         | 400    | Malformed or otherwise unprocessable request             |
| `UNAUTHORIZED`        | 401    | Missing or invalid credentials                           |
| `TOKEN_EXPIRED`       | 401    | Access/refresh token has expired                         |
| `FORBIDDEN`           | 403    | Authenticated user lacks permission                      |
| `NOT_FOUND`           | 404    | Requested resource or route does not exist               |
| `CONFLICT`            | 409    | Unique constraint or conflicting state                   |
| `RATE_LIMIT_EXCEEDED` | 429    | Too many requests                                        |
| `PAYLOAD_TOO_LARGE`   | 413    | Request payload exceeds the allowed size                 |
| `INTERNAL_ERROR`      | 500    | Unexpected server error                                  |
| `DATABASE_ERROR`      | 500    | Unmapped database failure (details hidden from clients)  |
| `DATABASE_UNAVAILABLE`| 503    | Database unreachable / timed out                         |
| `EXTERNAL_SERVICE_ERROR` | 502 | Upstream provider failed                                |
| `SERVICE_UNAVAILABLE` | 503    | Service temporarily unavailable                          |

Domain-specific codes (for example `CREATOR_NOT_FOUND`, `WALLET_VERIFICATION_FAILED`) are also
returned where more precision helps clients; they follow the same envelope.

## Localization

Generic messages are localized using the `Accept-Language` header. Supported locales: `en`, `es`,
`fr`, `pt`. Domain-specific messages (for example `"Cannot tip yourself"`) are always returned
verbatim so no context is lost.

## Error tracking

Errors are counted in Prometheus as `dorisio_errors_total{code,status,operational}` and are exposed
on `GET /metrics`. When `SENTRY_DSN` is configured, errors are also forwarded to a Sentry-compatible
endpoint. Tracking is best-effort and never affects the response returned to the client.
