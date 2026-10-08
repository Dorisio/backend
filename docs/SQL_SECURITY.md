# SQL security and Prisma query policy

Application data access uses Prisma first. Services should use model methods
(`findUnique`, `findMany`, `create`, `update`, `delete`, and the aggregate
APIs) so input is represented as data rather than assembled into SQL.

## Rules

1. Never concatenate request data into a query.
2. Never use Prisma's `$queryRawUnsafe` or `$executeRawUnsafe` APIs.
3. If a raw query is unavoidable, use Prisma's tagged-template form
   (`$queryRaw\`...${value}...\`` or `$executeRaw\`...${value}...\``), keep it
   in a reviewed infrastructure module, and add a focused injection test.
4. Queries made through the lower-level `pg` pool must pass values through the
   parameter array. Identifiers such as migration-table names must come only
   from constants controlled by the application, never from request input.
5. Validate and normalize input at the route boundary with the existing Zod
   schemas before calling a service. Validation is defence in depth; it does
   not replace parameterization.

The repository's health probe uses one constant tagged query, and the
migration/query-optimization modules contain reviewed infrastructure queries.
Those exceptions are intentionally isolated and must not be copied into
domain services.

## Local and CI audit

Run the static guard before opening a pull request:

```bash
pnpm sql:audit
```

The guard rejects unsafe Prisma APIs in application code. New raw SQL also
requires a test proving that attacker-controlled quotes and SQL operators are
treated as values, plus a note in the pull request explaining why Prisma
cannot express the operation.
