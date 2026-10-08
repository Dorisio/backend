# Testing guide

## Local checks

The Makefile mirrors the repository checks:

```bash
make format-check
make lint
make type-check
make test
```

`make test` runs Vitest once. Use `pnpm test:watch` while developing. Run a
focused test with `pnpm vitest run path/to/file.test.ts`.

## Test layers

- Unit tests cover services, validation, middleware, configuration, and
  utilities. They should not require PostgreSQL, Redis, or network access.
- Integration tests live under `src/**/__tests__/integration` and exercise
  routes with real application wiring. Start the Compose dependencies first.
- Prisma tests validate schema, migration, index, and concurrency invariants.

## Before opening a pull request

1. Add or update a focused test for every behavior change.
2. Run the focused test while iterating.
3. Run `make format-check`, `make lint`, `make type-check`, and `make test`.
4. If a test needs an external dependency, document the required service and
   keep a deterministic unit-test path with mocks.
