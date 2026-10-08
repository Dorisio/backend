# API gateway

The deployable gateway configuration is `infra/gateway/kong.yml`. Kong is
kept outside the application process so routing, authentication policy,
rate-limiting, correlation IDs, and Prometheus metrics remain available when
the backend is scaled horizontally.

## Configuration

Set `DORISIO_API_URL` to the service-discovery address of the backend and
`GATEWAY_RATE_LIMIT_PER_MINUTE` to the environment-specific limit. The same
declarative file can be used in development, staging, and production because
the upstream URL and limit are injected by the deployment environment.

The `/api` route forwards the original path to the backend. `/health` and
`/readiness` are exposed separately for load balancers and Kubernetes probes.
Kong adds `X-Request-Id`, applies the gateway rate limit, validates JWT
expiration/signing credentials provisioned as Kong consumers, and publishes
Prometheus metrics. Authentication remains enforced by the backend's JWT
middleware as well; this is intentional defense in depth, so a direct service
address cannot bypass authorization. Public routes can be exempted with a
separate Kong route/plugin override rather than weakening the API-wide policy.

Run Kong with the mounted file in a controlled environment:

```bash
docker run --rm --network host \
  -e KONG_DATABASE=off -e KONG_DECLARATIVE_CONFIG=/kong/kong.yml \
  -v "$PWD/infra/gateway/kong.yml:/kong/kong.yml:ro" \
  kong:3 kong start --conf /etc/kong/kong.conf
```

Service discovery is supplied by the orchestrator (for example, the
`backend` Kubernetes Service). Do not commit credentials or environment-
specific hostnames to this file.
