# Centralized Logging (#26)

## What was already in place

`src/utils/logger.ts` already used Pino with structured JSON output in
production (`transport: undefined` when `NODE_ENV === 'production'` means
raw JSON to stdout — the pretty-printed, colorized output is dev-only).
Levels (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) were already
configurable via `LOG_LEVEL`.

## What was missing, and what this PR adds

**Request context was not actually in every log line.** 11 files logged
via the module-level `logger` export, not Fastify's request-scoped
`request.log` — so despite Fastify auto-generating a `reqId` internally,
none of the application's own log calls carried it, making it impossible
to correlate one request's logs across services once centralized.

Fixed via `src/lib/requestContext.ts` (`AsyncLocalStorage`) +
`src/plugins/requestLogging.ts` (establishes the context per request,
honoring an incoming `X-Request-Id` header and echoing it back) +
`utils/logger.ts`'s Pino `mixin` (reads the active context and injects
`requestId`/`userId` into every log call). This required no changes to
any of the 11 existing call sites — every `logger.info(...)` /
`logger.error(...)` call anywhere in a request's call stack now
automatically includes `requestId`, and `userId` once
`authMiddleware` resolves it.

## What's intentionally left as an infrastructure decision, not app code

The remaining requirements are about where logs *go* and how they're
*operated*, not something `dorisio/backend`'s code should decide
unilaterally:

- **Log transport/aggregation** (ELK / Datadog / CloudWatch): Pino
  supports shipping via a `transport` target (e.g.
  `pino-datadog-transport`, `pino-cloudwatch`, or a Logstash TCP
  transport for ELK) — swap the production branch of `utils/logger.ts`'s
  `transport` option for whichever target the org standardizes on.
  Left unset here because the choice depends on what's already deployed
  operationally (which of ELK/Datadog/CloudWatch, if any, the org
  actually runs), which is outside this repo.
- **Retention** (7 days hot / 30 days archived, per the issue):
  configured on the aggregation service's side (e.g. a CloudWatch Logs
  retention policy, or an ILM policy in Elasticsearch), not in
  application code.
- **Dashboards & alerts** (request volume, error rate, latency
  percentiles; >100 errors/min, >5% error rate): built in the
  aggregation service once one is chosen, using the `requestId`/`userId`
  fields this PR guarantees are now present on every log line.
- **Sampling** (100% errors, 10% debug on high-traffic endpoints):
  best implemented at the transport/aggregation layer (most log shippers
  support level- or rate-based sampling natively) rather than
  conditionally suppressing `logger.debug()` calls in application code,
  which would make local debugging inconsistent with what actually ships.

## Verifying request correlation locally

```ts
import { logger } from './utils/logger';
import { runWithRequestContext } from './lib/requestContext';

runWithRequestContext({ requestId: 'test-123', userId: 'user-1' }, () => {
  logger.info('this line includes requestId and userId automatically');
});
```

Or, end-to-end: any request to a running instance now gets an
`X-Request-Id` response header (generated, or echoed back if the caller
sent one), and every log line for that request — anywhere in the call
stack — carries the same `requestId`.
