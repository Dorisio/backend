import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { logger } from '../utils/logger';

export type MigrationDirection = 'up' | 'down';

export interface MigrationDefinition {
  name: string;
  version: string;
  up: string | string[];
  down: string | string[];
  transaction?: boolean;
  description?: string;
}

export interface MigrationApplyOptions {
  dryRun?: boolean;
  transaction?: boolean;
  validate?: boolean;
}

export interface MigrationRecord {
  name: string;
  version: string;
  checksum: string;
  direction: MigrationDirection;
  executionTimeMs: number;
  success: boolean;
  appliedAt: string | null;
}

export interface MigrationResult extends MigrationRecord {
  applied: boolean;
  dryRun: boolean;
  skipped: boolean;
  message: string;
}

const MIGRATION_TABLE = '_prisma_migrations';
const VERSION_PATTERN = /^\d{8}_\d{6}$|^\d{14}$/;
const NAME_PATTERN = /^\d{8}_\d{6}_[a-z0-9_-]+$/i;

const DEFAULT_MIGRATION: MigrationDefinition = {
  name: '20260924_120000_add_status_index',
  version: '20260924_120000',
  up: ['CREATE INDEX IF NOT EXISTS idx_users_role ON "User" (role);'],
  down: ['DROP INDEX IF EXISTS idx_users_role;'],
  transaction: true,
  description: 'Add status index to users table',
};

function normalizeStatements(input: string | string[] | undefined): string[] {
  const statements = Array.isArray(input) ? input : input ? [input] : [];
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !/^--/.test(statement));
}

function toMigrationNameVersion(migrationName: string): { version: string; name: string } {
  const parts = migrationName.split('_');
  const version = parts.length >= 2 ? `${parts[0]}_${parts[1]}` : parts[0] ?? '';
  return {
    version,
    name: migrationName,
  };
}

export function buildMigrationChecksum(migration: MigrationDefinition): string {
  const hash = createHash('sha256');
  const input = [
    migration.name,
    Array.isArray(migration.up) ? migration.up.join('\n') : migration.up,
    Array.isArray(migration.down) ? migration.down.join('\n') : migration.down,
  ].join('\n');

  return hash.update(input).digest('hex').slice(0, 64);
}

export const ensureMigrationsTable = async (pool: Pool): Promise<void> => {
  const query = `
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR NOT NULL UNIQUE,
      finished_at TIMESTAMP DEFAULT NOW(),
      execution_time BIGINT DEFAULT 0,
      success BOOLEAN DEFAULT TRUE
    );
  `;

  try {
    await pool.query(query, undefined);
    logger.info('Migrations table initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to create migrations table');
    throw error;
  }
};

export const recordMigration = async (
  pool: Pool,
  migrationName: string,
  executionTime: number,
  _options: Partial<{
    version: string;
    checksum: string;
    direction: MigrationDirection;
    success: boolean;
  }> = {}
): Promise<void> => {
  const query = `
    INSERT INTO ${MIGRATION_TABLE} (migration_name, execution_time, success)
    VALUES ($1, $2, true)
    ON CONFLICT (migration_name) DO NOTHING;
  `;

  try {
    await pool.query(query, [migrationName, executionTime]);
    logger.info(`Migration recorded: ${migrationName}`);
  } catch (error) {
    logger.error({ error, migrationName }, 'Failed to record migration');
    throw error;
  }
};

export class MigrationRunner {
  private readonly migrations = new Map<string, MigrationDefinition>();

  constructor(
    private readonly pool: Pool,
    migrations: MigrationDefinition[] = [DEFAULT_MIGRATION]
  ) {
    for (const migration of migrations) {
      this.register(migration);
    }
  }

  register(migration: MigrationDefinition): void {
    const normalized = this.normalizeMigration(migration);
    this.migrations.set(normalized.name, normalized);
  }

  async initialize(): Promise<void> {
    await ensureMigrationsTable(this.pool);
  }

  async getHistory(): Promise<MigrationRecord[]> {
    const result = await this.pool.query(`SELECT * FROM ${MIGRATION_TABLE} ORDER BY id ASC`);
    return result.rows.map((row) => ({
      name: row.migration_name,
      version: toMigrationNameVersion(row.migration_name).version,
      checksum: '',
      direction: 'up',
      executionTimeMs: Number(row.execution_time ?? 0),
      success: Boolean(row.success ?? true),
      appliedAt: row.finished_at ?? null,
    }));
  }

  async listPending(migrations: MigrationDefinition[] = Array.from(this.migrations.values())): Promise<MigrationDefinition[]> {
    const history = await this.getHistory();
    const appliedNames = new Set(history.map((item) => item.name));
    return migrations.filter((migration) => !appliedNames.has(migration.name));
  }

  async isApplied(name: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT * FROM ${MIGRATION_TABLE} WHERE migration_name = $1 LIMIT 1`,
      [name]
    );
    return result.rowCount > 0;
  }

  validateMigration(migration: MigrationDefinition): void {
    if (!migration || typeof migration !== 'object') {
      throw new Error('Invalid migration definition');
    }

    if (!migration.name || !NAME_PATTERN.test(migration.name)) {
      throw new Error(`Invalid migration: '${migration.name}' must match YYYYMMDD_HHMMSS_name`);
    }

    if (!migration.version || !VERSION_PATTERN.test(migration.version)) {
      throw new Error(`Invalid migration version: ${migration.version}. Use YYYYMMDD_HHMMSS.`);
    }

    const upStatements = normalizeStatements(migration.up);
    const downStatements = normalizeStatements(migration.down);

    if (upStatements.length === 0) {
      throw new Error(`Invalid migration: '${migration.name}' must define at least one UP statement.`);
    }

    if (downStatements.length === 0) {
      throw new Error(`Invalid migration: '${migration.name}' must define at least one DOWN statement.`);
    }
  }

  private normalizeMigration(migration: MigrationDefinition): MigrationDefinition {
    this.validateMigration(migration);
    return {
      ...migration,
      up: normalizeStatements(migration.up),
      down: normalizeStatements(migration.down),
      transaction: migration.transaction ?? true,
    };
  }

  private async executeInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    await this.pool.query('BEGIN');
    try {
      const result = await callback();
      await this.pool.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.pool.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback migration transaction');
      }
      throw error;
    }
  }

  async apply(
    migration: MigrationDefinition,
    options: MigrationApplyOptions = {}
  ): Promise<MigrationResult> {
    const definition = this.normalizeMigration(migration);
    this.register(definition);
    await this.initialize();

    if (await this.isApplied(definition.name)) {
      return {
        name: definition.name,
        version: definition.version,
        checksum: buildMigrationChecksum(definition),
        direction: 'up',
        executionTimeMs: 0,
        success: true,
        appliedAt: null,
        applied: false,
        dryRun: !!options.dryRun,
        skipped: true,
        message: `Migration ${definition.name} already applied`,
      };
    }

    if (options.dryRun) {
      return {
        name: definition.name,
        version: definition.version,
        checksum: buildMigrationChecksum(definition),
        direction: 'up',
        executionTimeMs: 0,
        success: true,
        appliedAt: null,
        applied: false,
        dryRun: true,
        skipped: false,
        message: `Dry run succeeded for ${definition.name}`,
      };
    }

    const statements = normalizeStatements(definition.up);
    const startedAt = Date.now();

    try {
      if (definition.transaction ?? true) {
        await this.executeInTransaction(async () => {
          for (const statement of statements) {
            await this.pool.query(statement);
          }
          await recordMigration(this.pool, definition.name, Date.now() - startedAt);
        });
      } else {
        for (const statement of statements) {
          await this.pool.query(statement);
        }
        await recordMigration(this.pool, definition.name, Date.now() - startedAt);
      }

      return {
        name: definition.name,
        version: definition.version,
        checksum: buildMigrationChecksum(definition),
        direction: 'up',
        executionTimeMs: Date.now() - startedAt,
        success: true,
        appliedAt: null,
        applied: true,
        dryRun: false,
        skipped: false,
        message: `Migration ${definition.name} applied successfully`,
      };
    } catch (error) {
      logger.error({ error, migration: definition.name }, 'Migration apply failed');
      throw error;
    }
  }

  async rollback(
    migrationName: string,
    options: MigrationApplyOptions = {}
  ): Promise<MigrationResult | null> {
    const migrationDefinition = this.migrations.get(migrationName) ?? this.migrations.get(DEFAULT_MIGRATION.name);

    if (!migrationDefinition) {
      throw new Error(`Migration '${migrationName}' is not registered.`);
    }

    const populated = this.normalizeMigration(migrationDefinition);
    await this.initialize();

    if (!(await this.isApplied(migrationName))) {
      return {
        name: populated.name,
        version: populated.version,
        checksum: buildMigrationChecksum(populated),
        direction: 'down',
        executionTimeMs: 0,
        success: true,
        appliedAt: null,
        applied: false,
        dryRun: !!options.dryRun,
        skipped: true,
        message: `Migration ${migrationName} is not applied`,
      };
    }

    if (options.dryRun) {
      return {
        name: populated.name,
        version: populated.version,
        checksum: buildMigrationChecksum(populated),
        direction: 'down',
        executionTimeMs: 0,
        success: true,
        appliedAt: null,
        applied: false,
        dryRun: true,
        skipped: false,
        message: `Dry run rollback succeeded for ${populated.name}`,
      };
    }

    const statements = normalizeStatements(populated.down);
    const startedAt = Date.now();

    try {
      if (populated.transaction ?? true) {
        await this.executeInTransaction(async () => {
          for (const statement of statements) {
            await this.pool.query(statement);
          }
          await this.pool.query(`DELETE FROM ${MIGRATION_TABLE} WHERE migration_name = $1`, [migrationName]);
        });
      } else {
        for (const statement of statements) {
          await this.pool.query(statement);
        }
        await this.pool.query(`DELETE FROM ${MIGRATION_TABLE} WHERE migration_name = $1`, [migrationName]);
      }

      return {
        name: populated.name,
        version: populated.version,
        checksum: buildMigrationChecksum(populated),
        direction: 'down',
        executionTimeMs: Date.now() - startedAt,
        success: true,
        appliedAt: null,
        applied: true,
        dryRun: false,
        skipped: false,
        message: `Migration ${populated.name} rolled back successfully`,
      };
    } catch (error) {
      logger.error({ error, migration: populated.name }, 'Migration rollback failed');
      throw error;
    }
  }

  async rollbackTo(targetVersion: string, options: MigrationApplyOptions = {}): Promise<MigrationResult[]> {
    const history = await this.getHistory();
    const relevant = history.filter((entry) => entry.version === targetVersion || entry.success);

    if (relevant.length === 0) {
      return [];
    }

    const results: MigrationResult[] = [];
    for (const record of [...relevant].reverse()) {
      const definition = this.migrations.get(record.name);
      if (!definition) {
        continue;
      }
      const result = await this.rollback(definition.name, options);
      if (result) {
        results.push(result);
      }
    }
    return results;
  }

  async applyAll(
    migrations: MigrationDefinition[],
    options: MigrationApplyOptions = {}
  ): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];
    for (const migration of migrations) {
      const result = await this.apply(migration, options);
      results.push(result);
    }
    return results;
  }
}

export const applyMigrations = async (
  pool: Pool,
  migrations: MigrationDefinition[],
  options: MigrationApplyOptions = {}
): Promise<MigrationResult[]> => {
  const runner = new MigrationRunner(pool, migrations);
  await runner.initialize();
  return runner.applyAll(migrations, options);
};

export const rollbackMigrations = async (
  pool: Pool,
  migrationName: string,
  options: MigrationApplyOptions = {}
): Promise<MigrationResult | null> => {
  const runner = new MigrationRunner(pool);
  await runner.initialize();
  return runner.rollback(migrationName, options);
};
