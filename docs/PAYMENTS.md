# Payment Processing

External payments (cards, wallets, crypto) are processed through a pluggable
`PaymentProvider`. The default implementation targets **Stripe** via its REST API
(no SDK dependency); tests and local development use a deterministic
`FakePaymentProvider`.

Raw card data is **never** accepted or stored. Only tokenized payment intent
references are persisted (PCI SAQ-A).

## Configuration

| Variable                             | Default                  | Description                                     |
| ------------------------------------ | ------------------------ | ----------------------------------------------- |
| `PAYMENTS_PROVIDER`                  | `none`                   | `stripe` to enable the provider                 |
| `STRIPE_SECRET_KEY`                  | –                        | Required when `PAYMENTS_PROVIDER=stripe`        |
| `STRIPE_WEBHOOK_SECRET`              | –                        | Required to accept webhooks                     |
| `STRIPE_API_BASE`                    | `https://api.stripe.com` | Override for proxies/sandboxes                  |
| `PAYMENTS_WEBHOOK_TOLERANCE_SECONDS` | `300`                    | Replay window for webhook timestamps            |

## Endpoints

| Method | Path                                | Auth | Description                                   |
| ------ | ----------------------------------- | ---- | --------------------------------------------- |
| POST   | `/api/v1/payments`                  | yes  | Create a payment intent                       |
| GET    | `/api/v1/payments`                  | yes  | List the caller's payments (paginated)        |
| GET    | `/api/v1/payments/:id`              | yes  | Fetch one payment (owner only)                |
| POST   | `/api/v1/payments/:id/refund`       | yes  | Refund in full or partially                   |
| POST   | `/api/v1/payments/webhooks/:provider` | no | Provider callback (signature verified)        |

## Idempotency

Create and refund requests are idempotent. Send an `Idempotency-Key` header (or a
body field of the same name); repeating the request returns the original result
instead of creating a second charge. Concurrent/duplicate webhook deliveries are
deduplicated by the unique provider event id.

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 6f1b6e2a-..." \
  -H "Content-Type: application/json" \
  -d '{"amount": 25, "currency": "USD", "method": "card", "creatorId": "creator_1"}'
```

## Status lifecycle

```
pending ─┬─▶ requires_action ─┬─▶ processing ─┬─▶ succeeded ─┬─▶ partially_refunded ─▶ refunded
         │                    │               │              └─▶ disputed
         ├─▶ processing ──────┘               └─▶ failed
         └─▶ canceled
```

Illegal transitions are rejected (`src/lib/payments/transitions.ts`), and every
state change appends a `PaymentEvent` audit record.

## Webhooks

The provider signs `<timestamp>.<raw body>` with HMAC-SHA256. The webhook route
captures the raw body (via an encapsulated content-type parser), verifies the
signature and timestamp tolerance, then records the event and applies the
matching status transition:

| Provider event                    | Resulting status                        |
| --------------------------------- | --------------------------------------- |
| `payment_intent.succeeded`        | `succeeded`                             |
| `payment_intent.payment_failed`   | `failed`                                |
| `payment_intent.canceled`         | `canceled`                              |
| `charge.refunded`                 | `refunded` / `partially_refunded`       |
| `charge.dispute.created`          | `disputed` (chargeback)                 |

Invalid signatures are rejected with `401` and never mutate state.

## Refunds

Refunds are validated against the refundable amount (sum of successful refunds),
so a payment can never be over-refunded. Partial refunds move the payment to
`partially_refunded`; a full refund moves it to `refunded`. Every refund writes
an audit event.

## Resilience

Provider calls are retried with exponential backoff for transient failures
(5xx/timeouts/429) and are not retried for caller errors (4xx). See
`src/lib/payments/retry.ts`.

## Data model

- `Payment` — the payment record (provider ref, amount, currency, status, method).
- `PaymentEvent` — append-only audit trail; `providerEventId` is unique.
- `Refund` — refund records with their own idempotency key.
