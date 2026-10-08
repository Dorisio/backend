# Response optimization

The server supports HTTP/2 (`HTTP2_ENABLED=true`) and negotiates Brotli,
gzip, or deflate through `@fastify/compress` for responses larger than 1 KiB.
HTTP/2 deployments should terminate TLS at the edge and forward h2c or HTTP/1
to the application according to the platform's support.

GET responses receive `RESPONSE_CACHE_CONTROL` (default:
`private, no-cache`) unless a route already supplied a cache policy. This
prevents stale private API data from being cached while allowing deployments
to set an explicit policy for public resources.

Clients may request a sparse top-level fieldset with `?fields=id,name`. The
projection is applied to JSON objects and each object in a JSON array. It is a
response projection only: authorization and route validation still happen
before serialization, and unknown fields are simply omitted.

Example:

```bash
curl --compressed 'https://api.example.com/api/v1/creators?fields=id,name'
```
