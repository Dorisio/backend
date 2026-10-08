# Creator Subscription Tiers

Creator API access is priced in tiers. The tier decides three things: the
**rate limit** a creator gets, the **features** they may call, and the
**usage limits** reported on their dashboard. All three read from one file, so a
limit can never drift between the pricing page, the enforcement point and the
invoice.

| Tier | Price | Requests / minute | Requests / day | Analytics history | Team members | Exports / month |
| --- | --- | --- | --- | --- | --- | --- |
| `free` | $0 | 60 | 5,000 | 30 days | 1 | 1 |
| `pro` | $19 / mo, $190 / yr | 300 | 50,000 | 365 days | 5 | 25 |
| `enterprise` | $99 / mo, $990 / yr | 1,500 | 500,000 | 1,095 days | 25 | 500 |

Features unlocked per tier (`advanced_analytics`, `analytics_export`,
`team_members`, `api_access`, `webhooks`, `priority_support`,
`custom_branding`): `free` has none, `pro` has the first four, `enterprise` has
all of them. `requireCreatorFeature(feature)` turns that into a `403` that names
the cheapest tier which would unlock it.

| File | Purpose |
| --- | --- |
| `src/config/creator-tiers.ts` | Plans, prices, limits, features, trial length, entitlement rules. **The only file you edit to change a plan.** |
| `src/lib/creator-tier-limits.ts` | Per-creator, per-tier limiter (minute + day windows) and the rate-limit headers. |
| `src/middleware/creator-tier.ts` | `requireCreator`, `enforceCreatorQuota`, `requireCreatorFeature`; resolves and caches the entitled tier. |
| `src/domains/creators/tier.service.ts` | Subscription state machine, invoices, buffered usage counters. |
| `src/domains/creators/tier.runtime.ts` | Wires the four pieces above into one process-wide runtime. |
| `src/domains/creators/tier.routes.ts` | The HTTP surface below. |

## Two limiters, and why

`src/plugins/rateLimit.ts` limits **callers per route class** and protects the
API from abuse; it cannot see who pays. The tier limiter here limits **creators
per plan** and is what a subscription buys:

- it keys on the **creator**, not the caller, so a team member or an API key
  spends the creator's budget instead of getting a fresh one;
- both windows apply at once: a daily cap alone lets a script spend a day's
  budget in a minute, and a minute cap alone allows 1,500 requests every minute
  all day;
- a request that exceeds the budget is **not** counted, so a throttled client
  cannot extend its own lockout.

Counters live in process memory, so a multi-instance deployment enforces the
limit per instance, the same trade-off the global limiter documents. Moving it
to Redis means replacing the limiter passed to `createCreatorTierRuntime`.

The exceeded response is `429` with the plan limits, the scope that tripped
(`minute` or `day`), the seconds to wait, and the next tier up:

```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Your Free plan allows 60 requests per minute and 5000 per day",
  "details": {
    "tier": "free",
    "scope": "minute",
    "limit": 60,
    "retryAfterSeconds": 42,
    "upgradeOptions": "pro"
  }
}
```

Every creator request also carries headers so a client can render the budget
without a second call: `x-creator-tier`, `x-creator-tier-minute-limit`,
`x-creator-tier-minute-remaining`, `x-creator-tier-day-limit`,
`x-creator-tier-day-remaining`, and, on a throttled route,
`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`,
`x-ratelimit-scope`, `retry-after`.

## Entitlement is not the stored tier

`resolveEffectiveTier` decides what a creator may actually do right now, and it
is deliberately more generous than the stored status:

| Stored status | Entitled to | Why |
| --- | --- | --- |
| `trialing` | the paid tier until `trialEndsAt`, then `free` | the trial is a real trial of the paid limits |
| `active` | the paid tier | — |
| `past_due` | the paid tier | downgrading on the first failed charge would break a paying customer; recovery belongs to the payment retry flow |
| `canceled` | the paid tier until `currentPeriodEnd`, then `free` | the period is already paid for |
| `expired` | `free` | — |

The resolver caches a creator's tier for 30 s, and every subscription write
invalidates that creator's entry, so a tier change is visible on the very next
request rather than after the TTL.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/creators/tier/plans` | Public. Prices in cents and in currency units. |
| `GET` | `/api/v1/creators/me/tier` | Current subscription, entitled tier, upgrade options. Never throttled. |
| `GET` | `/api/v1/creators/me/tier/usage` | Month-to-date counters against the plan limits. Never throttled. |
| `GET` | `/api/v1/creators/me/tier/invoices` | Invoice history. Spends tier quota. |
| `POST` | `/api/v1/creators/me/tier/upgrade` | `{ tier, billingPeriod?, startTrial? }`. |
| `POST` | `/api/v1/creators/me/tier/downgrade` | `{ tier, immediate? }` — deferred to the period end by default. |
| `POST` | `/api/v1/creators/me/tier/cancel` | `{ immediate? }` — keeps access until the period ends. |
| `POST` | `/api/v1/creators/me/tier/resume` | Undoes a scheduled cancellation or downgrade. |

Subscription reads are never rate limited: a creator who has just been throttled
still has to be able to fetch their plan and the upgrade path.

Analytics reads (`/api/v1/analytics/*`) run through the same tier middleware, so
they spend the creator's budget and are throttled per plan.

## Billing

`TierBillingProvider` is a one-method seam. The default provider issues an
**open** invoice and leaves it to the platform's existing payment flow to settle,
which makes an upgrade from `free` return `202` with `paymentRequired: true` and
change nothing until `markInvoicePaid` is called; a PSP adapter that collects
synchronously returns `paid` and activates the tier in the same request. The
per-creator `provider*` columns on `CreatorSubscription` are the existing Stripe
customer/subscription ids, so an adapter can reuse what the payments domain
already has.

A first upgrade may start a **free trial** (14 days on `pro` and `enterprise`),
once per creator: `wantsTrial` requires the stored tier to still be `free` and
`trialEndsAt` to be null. Upgrades are prorated over the remaining days of a
**paid** period; a free or trialing period has no paid days to credit, so it is
billed at list price. `processDueRenewals` is the scheduler entry point: it
expires an ended trial, applies a scheduled downgrade or cancellation, and
invoices a plain renewal, leaving `past_due` subscriptions to the retry flow.

## Usage counting

`CreatorUsageService` keeps counters in memory per creator, per month and flushes
them as one `upsert` per creator, so a request path costs a Map update instead of
a database write. Reads add buffered counters to the stored row, so a creator
never sees a total that lags behind their own traffic. Low-volume events that
cannot wait for the next flush call `record()`, which increments and flushes
immediately.
