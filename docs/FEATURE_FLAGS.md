# Feature flags and progressive rollout

The feature flag evaluator lives in `src/config/feature-flags.ts`. The existing
`isFeatureEnabled(flag)` API remains the compatibility path for environment-only
boolean flags. New request-aware code should use a `FeatureFlagService` snapshot.

## Configuration contract

A snapshot is an immutable-at-the-call-boundary object that can be replaced atomically:

```ts
const snapshot = createFeatureFlagSnapshot(
  {
    exports: {
      enabled: true,
      percentage: 25,
      allow: { users: ['internal-user'], roles: ['admin'] },
      deny: { users: ['blocked-user'], roles: ['suspended'] },
    },
  },
  'release-2026-09-29'
);

const flags = new FeatureFlagService(snapshot);
flags.isEnabled('exports', { userId: 'user-123', role: 'creator' });
```

Each definition supports:

- `enabled`: explicit boolean. `enabled: false` is an immediate kill switch and
  always wins, including over allow lists. `enabled: true` is the boolean fallback.
- `percentage` (or `rolloutPercentage`): a number from `0` through `100`. Assignment
  requires `userId` and uses SHA-256 over a versioned salt, flag name, and user ID;
  the same user stays in the same bucket across processes and restarts.
- `allow` / `deny`: `{ users?: string[], roles?: string[] }`. The shorthand
  `allowUsers`, `denyUsers`, `allowRoles`, and `denyRoles` is also accepted.

Targeting is evaluated in this order:

1. Disabled kill switch
2. Deny user, then deny role
3. Allow user, then allow role
4. Boolean value
5. Percentage rollout
6. Safe default (`false`), including percentage rules without a user ID

Deny always wins over allow. Unknown flags and malformed rollout percentages are
safe-off. Do not place secrets or raw user identifiers in snapshots sent to logs.

## Snapshots and Redis synchronization

`InMemoryFeatureFlagStore` is intentionally small and atomic. It implements
`FeatureFlagSnapshotStore`, so a Redis adapter can implement `read()` and call
`syncFeatureFlagSnapshot(store, source)` from a polling or pub/sub consumer. A
snapshot replacement is an instant rollout update or rollback; setting
`enabled: false` is the safest emergency disable.

Snapshots should be versioned by the producer. The service returns the version in
evaluation results, which makes rollout diagnostics possible without logging IDs.

## Fastify routes

Use the pre-handler helper on protected routes:

```ts
app.get(
  '/exports',
  {
    preHandler: [requireFeature(flags, 'exports', { requireUserContext: true })],
  },
  handler
);
```

`featureRoute(flags, 'exports')` returns the equivalent `{ preHandler }` object.
Denied requests raise the repository's normal `FORBIDDEN` (`403`) error. The
middleware derives `userId`, `role`, and `roles` from `request.user`, and does not
include identifiers in logs.

## Metrics and logging

`FeatureEvaluationMetrics` aggregates only total/enabled/disabled counts, flag names,
and bounded reason labels (`percentage`, `allow_role`, `deny_user`, etc.). It never
stores user IDs. Pass a logger with the `FeatureFlagLogger` shape to the service to
receive debug events containing only `{ flag, enabled, reason }`.
