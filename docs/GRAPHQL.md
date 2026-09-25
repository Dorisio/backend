# GraphQL API

Issue #30. Available alongside the REST API at **`POST /graphql`** (GraphiQL in non-production).

## Auth

Same Bearer JWT as REST: `Authorization: Bearer <token>`.

## Limits

| Knob | Env | Default |
|------|-----|---------|
| Max depth | `GRAPHQL_MAX_DEPTH` | `5` |
| Max complexity | `GRAPHQL_MAX_COMPLEXITY` | `100` |
| Enable | `GRAPHQL_ENABLED` | `true` |

## Example query

```graphql
query {
  creators(limit: 5) { id username verified }
  tips(limit: 5) { id amount status }
}
```

## Example mutation

```graphql
mutation {
  enqueueAnalytics(creatorId: "clx...", rangeDays: 7) { id queue }
}
```

Resolvers reuse Prisma / job enqueue helpers — no duplicated business logic.
