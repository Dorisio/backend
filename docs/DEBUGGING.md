# Debugging guide

## Start a reproducible local environment

```bash
cp .env.example .env.local
make setup
```

The Compose stack provides PostgreSQL and Redis. The backend is available at
`http://localhost:3000`; its health endpoint is:

```bash
curl http://localhost:3000/health
```

Use `make logs` to follow the backend container. For a local process, run
`pnpm dev` after starting PostgreSQL and Redis with `make up`.

## Common failures

- **Database connection refused:** confirm `make up` completed and that
  `DATABASE_URL` points to the host/port you are using. Inside Compose, use
  `postgres` as the hostname; from the host, use `localhost`.
- **Redis connection refused:** check `docker compose ps` and verify
  `REDIS_URL`. The health check is `docker compose exec redis redis-cli ping`.
- **Prisma client errors:** run `make generate`, then `make migrate`.
- **Migration state differs:** use `pnpm prisma migrate status`. Do not use
  `prisma migrate reset` unless the database is disposable.
- **Missing Stellar configuration:** development uses testnet by default. Keep
  server keys in `.env.local`; never commit them or paste them into issue
  reports.
- **Port already in use:** set `PORT` in `.env.local`, then restart the
  backend container.

## Debugging tests

Run one file or one test by passing Vitest arguments:

```bash
pnpm vitest run src/domains/payments/payment.service.test.ts
pnpm vitest run -t "rejects duplicate"
```

Keep external services out of unit tests by mocking Prisma, Redis, Stellar, and
email providers. Use the integration tests only when the required services are
running.
