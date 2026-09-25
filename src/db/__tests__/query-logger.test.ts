import { describe, it, expect, vi } from 'vitest';
import {
  QueryLogger,
  normalizeQueryName,
  normalizeSql,
  sanitizeParams,
  sanitizeSql,
} from '../query-logger';
import { logger } from '../../utils/logger';

describe('QueryLogger', () => {
  it('should sanitize extra whitespace in SQL', () => {
    const rawSql = `
      SELECT   *
      FROM     "User"
      WHERE    id = $1
    `;
    expect(sanitizeSql(rawSql)).toBe('SELECT * FROM "User" WHERE id = $1');
  });

  it('should mask sensitive parameters', () => {
    const params = [
      'user_123',
      {
        password: 'super_secret_password',
        secret: 'stellar_secret',
        name: 'Alice',
      },
    ];

    const sanitized = sanitizeParams(params) as Array<Record<string, unknown> | string>;
    expect(sanitized[0]).toBe('user_123');
    expect((sanitized[1] as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((sanitized[1] as Record<string, unknown>).secret).toBe('[REDACTED]');
    expect((sanitized[1] as Record<string, unknown>).name).toBe('Alice');
  });

  it('should truncate excessively long parameter strings', () => {
    const longParam = 'a'.repeat(600);
    const sanitized = sanitizeParams([longParam]);
    expect(typeof sanitized?.[0]).toBe('string');
    expect((sanitized?.[0] as string).includes('...[TRUNCATED 600 bytes]')).toBe(true);
  });

  it('should log slow queries with warn level when threshold is exceeded', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const qLogger = new QueryLogger({ slowQueryThresholdMs: 100 });

    qLogger.logQuery({
      queryName: 'find_all_tips',
      sql: 'SELECT * FROM "Tip"',
      durationMs: 250,
      rowCount: 50,
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('should log query errors with error level', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const qLogger = new QueryLogger({ slowQueryThresholdMs: 100 });

    qLogger.logQuery({
      queryName: 'failing_query',
      sql: 'SELECT * FROM non_existent',
      durationMs: 10,
      error: new Error('table does not exist'),
    });

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('normalizeSql', () => {
  it('collapses literals, comments and formatting into one fingerprint', () => {
    const a = normalizeSql(`SELECT * FROM "Tip" WHERE status = 'pending' AND id = 42`);
    const b = normalizeSql(`-- filtered\n  SELECT  *\nFROM "Tip"\n WHERE status = 'failed'  AND id = 7`);

    expect(a).toBe(b);
    expect(a).not.toContain('42');
    // Quoted identifiers are preserved; only literals become placeholders.
    expect(normalizeSql('SELECT * FROM "Tip" WHERE id IN (1, 2, 3)')).toBe(
      'SELECT * FROM "Tip" WHERE id IN (?)'
    );
  });

  it('keeps metric label cardinality bounded', () => {
    const names = new Set([
      normalizeQueryName('User.findUnique'),
      normalizeQueryName('Tip create; DROP'),
      normalizeQueryName(undefined),
    ]);

    expect(names.has('User.findUnique')).toBe(true);
    expect(names.has('Tip_create__DROP')).toBe(true);
    expect(names.has('unnamed_query')).toBe(true);
  });
});

describe('slow query history', () => {
  it('keeps the most recent slow queries and drops the oldest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const qLogger = new QueryLogger({ slowQueryThresholdMs: 10, slowQueryHistorySize: 2 });

    for (const ms of [50, 60, 70]) {
      qLogger.logQuery({
        queryName: 'find_tips',
        operation: 'Tip.findMany',
        sql: 'SELECT * FROM "Tip"',
        durationMs: ms,
        rowCount: 1,
      });
    }

    const slow = qLogger.getSlowQueries();
    expect(slow).toHaveLength(2);
    expect(slow[0].durationMs).toBe(70);
    expect(slow[1].durationMs).toBe(60);
    expect(slow[0].queryName).toBe('find_tips');
    expect(slow[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(qLogger.getSlowQueryCount()).toBe(3);

    qLogger.resetSlowQueries();
    expect(qLogger.getSlowQueries()).toEqual([]);
    expect(qLogger.getSlowQueryCount()).toBe(0);
    warnSpy.mockRestore();
  });

  it('does not record fast queries', () => {
    const qLogger = new QueryLogger({ slowQueryThresholdMs: 1000 });

    qLogger.logQuery({
      queryName: 'fast',
      operation: 'Tip.findMany',
      sql: 'SELECT * FROM "Tip"',
      durationMs: 1,
    });

    expect(qLogger.getSlowQueries()).toEqual([]);
  });

  it('exposes runtime-configurable thresholds and log switch', () => {
    const qLogger = new QueryLogger();
    expect(qLogger.getLogQueries()).toBe(false);

    qLogger.setLogQueries(true);
    qLogger.setSlowQueryThreshold(25);

    expect(qLogger.getLogQueries()).toBe(true);
    expect(qLogger.getSlowQueryThreshold()).toBe(25);
  });

  it('logs fast queries at debug level when query logging is enabled', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const qLogger = new QueryLogger({ logQueries: true, slowQueryThresholdMs: 1000 });

    qLogger.logQuery({
      queryName: 'find_wallet',
      operation: 'Wallet.findFirst',
      sql: 'SELECT * FROM "Wallet"',
      params: [{ publicKey: 'GABC', secret: 'top-secret' }],
      durationMs: 3,
    });

    expect(debugSpy).toHaveBeenCalled();
    const payload = debugSpy.mock.calls[0][0] as unknown as {
      params: Array<Record<string, unknown>>;
    };
    expect(payload.params[0].secret).toBe('[REDACTED]');
    expect(payload.params[0].publicKey).toBe('GABC');
    debugSpy.mockRestore();
  });
});
