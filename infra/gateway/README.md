# Gateway configuration

`kong.yml` is the versioned, environment-neutral gateway definition for
Dorisio. It routes API traffic to the backend, separates health probes,
propagates request IDs, rate-limits traffic, and exposes metrics. See
[`docs/API_GATEWAY.md`](../../docs/API_GATEWAY.md) for deployment guidance.
