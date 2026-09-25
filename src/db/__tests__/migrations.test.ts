import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensureMigrationsTable,
  recordMigration,
  MigrationRunner,
  type MigrationDefinition,
} from '../migrations';

describe('database migration framework', () => {
  const migration: MigrationDefinition = {
    name: '20260924_120000_add_status_index',
    version: '20260924_120000',
    up: ['CREATE INDEX IF NOT EXISTS idx_users_role ON "User" (role);'],
    down: ['DROP INDEX IF EXISTS idx_users_role;'],
    transaction: true,
  };

  const createPool = () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string | { text: string }, params?: any[]) => {
        const sqlText = typeof sql === 'string' ? sql : sql.text;
        queries.push(sqlText);
        if (sqlText.toLowerCase().includes('select * from _prisma_migrations')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        release: vi.fn(),
      })),
    } as any;

    return { pool, queries };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the migration tracking table', async () => {
    const { pool } = createPool();

    await ensureMigrationsTable(pool);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('_prisma_migrations'),
      undefined
    );
  });

  it('records migration history after a successful apply', async () => {
    const { pool } = createPool();

    await recordMigration(pool, '20260924_120000_add_status_index', 100);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO _prisma_migrations'),
      ['20260924_120000_add_status_index', 100]
    );
  });

  it('applies an up migration and tracks state', async () => {
    const { pool } = createPool();
    const runner = new MigrationRunner(pool);

    const result = await runner.apply(migration, { dryRun: false });

    expect(result?.name).toBe(migration.name);
    expect(result?.applied).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO _prisma_migrations'),
      expect.any(Array)
    );
  });

  it('supports a dry run without persisting the migration', async () => {
    const { pool } = createPool();
    const runner = new MigrationRunner(pool);

    const result = await runner.apply(migration, { dryRun: true });

    expect(result?.applied).toBe(false);
    expect(result?.dryRun).toBe(true);
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO _prisma_migrations'),
      expect.any(Array)
    );
  });

  it('reverts a migration with the down script', async () => {
    const { pool } = createPool();
    const runner = new MigrationRunner(pool);
    await runner.initialize();

    const result = await runner.rollback(migration.name, { dryRun: false });

    expect(result?.name).toBe(migration.name);
    expect(result?.direction).toBe('down');
  });

  it('rejects invalid migration definitions before applying', async () => {
    const { pool } = createPool();
    const runner = new MigrationRunner(pool);

    await expect(
      runner.apply({
        name: 'bad migration',
        version: 'bad-version',
        up: [],
        down: [],
      })
    ).rejects.toThrow(/invalid migration/i);
  });

  it('does not reapply a migration already recorded', async () => {
    const { pool } = createPool();
    const runner = new MigrationRunner(pool);
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.toLowerCase().includes('select * from _prisma_migrations')) {
        return { rows: [{ migration_name: migration.name }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await runner.apply(migration);

    expect(result?.applied).toBe(false);
    expect(result?.skipped).toBe(true);
  });
});
