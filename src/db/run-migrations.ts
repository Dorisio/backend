import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { config } from '../config';
import { MigrationRunner } from './migrations';
import { defaultMigrations } from './migrationDefinitions';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const rollback = args.has('--down');
const targetVersion = Array.from(args).find((arg) => arg.startsWith('--to='))?.split('=')[1];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? config.DATABASE_URL,
});

const runner = new MigrationRunner(pool, defaultMigrations);

async function main(): Promise<void> {
  await runner.initialize();

  if (dryRun) {
    const pending = await runner.listPending(defaultMigrations);
    if (pending.length === 0) {
      logger.info('No pending migrations for dry run.');
      return;
    }

    for (const migration of pending) {
      await runner.apply(migration, { dryRun: true, validate: true });
    }
    logger.info({ count: pending.length }, 'Dry run finished without applying migrations');
    return;
  }

  if (rollback) {
    if (targetVersion) {
      const results = await runner.rollbackTo(targetVersion, { dryRun: false });
      logger.info({ count: results.length }, 'Rollback to target version completed');
      return;
    }

    const latest = defaultMigrations.at(-1);
    if (!latest) {
      logger.info('No migrations to roll back.');
      return;
    }

    const result = await runner.rollback(latest.name, { dryRun: false });
    logger.info({ result }, 'Rollback completed');
    return;
  }

  const pending = await runner.listPending(defaultMigrations);
  if (pending.length === 0) {
    logger.info('No pending migrations.');
    return;
  }

  for (const migration of pending) {
    await runner.apply(migration, { dryRun: false, validate: true });
  }

  logger.info({ count: pending.length }, 'Migrations applied successfully');
}

main()
  .catch((error) => {
    logger.error({ error }, 'Migration runner failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
