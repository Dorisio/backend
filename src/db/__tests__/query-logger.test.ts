import { describe, it, expect, vi } from 'vitest';
import { QueryLogger, sanitizeParams, sanitizeSql } from '../query-logger';
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
