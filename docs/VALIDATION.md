# Request Validation & Sanitization

All input is validated and sanitized **at the request boundary**, before any
service or database call, using schema-based validation (Zod).

## Middleware

```ts
import { validateRequest } from '../middleware/validation';

app.post('/api/v1/example', {
  preHandler: [authMiddleware, validateRequest({ body: ExampleSchema })],
  schema: { body: exampleJsonSchema }, // derived from the same Zod schema
}, handler);
```

`validateRequest` accepts a schema per request location (`body`, `query`,
`params`). It:

1. Sanitizes string values (recursively for objects/arrays).
2. Parses the input with the Zod schema.
3. Writes the parsed, sanitized values back onto the request so downstream code
   only ever sees trusted data.
4. Throws a `RequestValidationError` (HTTP 400, code `VALIDATION_ERROR`) with
   field-level `details.issues` on failure.

Fastify route `schema` objects are **derived from the same Zod schemas**
(`zodToJsonSchema`), so OpenAPI documentation can never drift from enforcement.

## Sanitization

`sanitizeString` removes control characters and, by default, strips HTML tags and
dangerous URL schemes (`javascript:`, `vbscript:`, `data:`) and trims
surrounding whitespace. It is intentionally an *allowlist-oriented normalization*
step — the schema remains the authority on what is valid.

## Error shape

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request data is invalid",
    "details": {
      "issues": [{ "path": "body.amount", "message": "Number must be greater than 0", "code": "too_small" }]
    }
  },
  "timestamp": "2026-09-24T12:00:00.000Z"
}
```

Schema internals are never echoed to clients.

## Stellar rules

| Rule             | Constraint                                              |
| ---------------- | ------------------------------------------------------- |
| Public key       | `StrKey.isValidEd25519PublicKey()`                      |
| Asset code       | 1–12 alphanumeric characters                            |
| Memo             | ≤ 28 UTF-8 bytes (validated before transaction building)|
| Amount           | Positive, ≤ 1,000,000, at most 7 decimal places         |
| Tip message      | Sanitized, ≤ 500 characters                             |

## Abuse protection

Repeated validation failures from the same client/route are counted in a
sliding window (`src/lib/failure-limiter.ts`). Once the threshold
(default: 20 failures / 15 minutes) is crossed the client receives a 429 and
further requests are short-circuited before validation. Every failure is logged
with the route, target, offending field paths and a flag for suspicious
injection patterns.
