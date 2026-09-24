import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initializeDatabase,
  getDatabase,
  getPoolMetrics,
  query,
  cachedQuery,
  executePreparedStatement,
  withClient,
  withTransaction,
  checkDatabaseHealth,
  closeDatabase,
  getCircuitBreaker,
} from '../connection';
import { createPreparedStatement } from '../query-optimizer';

// Mock pg
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');

  class MockPoolClient extends EventEmitter {
    public query = vi.fn().mockImplementation(async (sqlOrConfig: any, _params?: any) => {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text;
      if (sql && sql.includes('FAIL_QUERY')) {
        throw new Error('Query execution failed');
      }
      return {
        rows: [{ id: 1, val: 'test' }],
        rowCount: 1,
      };
    });
    public release = vi.fn();
  }

  class MockPool extends EventEmitter {
    public totalCount = 5;
    public idleCount = 3;
    public waitingCount = 0;
    public options: any;

    constructor(options: any) {
      super();
      this.options = options;
    }

    public connect = vi.fn().mockImplementation(async () => {
      const client = new MockPoolClient();
      this.emit('acquire', client);
      const originalRelease = client.release;
      client.release = vi.fn().mockImplementation(() => {
        this.emit('release', undefined, client);
        originalRelease.call(client);
      });
      return client;
    });

    public query = vi.fn().mockImplementation(async (sqlOrConfig: any, _values?: any) => {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text;
      if (sql && sql.includes('FAIL_QUERY')) {
        throw new Error('Database pool query failed');
      }
      return {
        rows: [{ id: 1, val: 'query_res' }],
        rowCount: 1,
      };
    });

    public end = vi.fn().mockResolvedValue(undefined);
  }

  return {
    Pool: MockPool,
  };
});

describe('Database Connection Pool & Lifecycle', () => {
  beforeEach(async () => {
    await closeDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('should initialize database pool with custom configurations', async () => {
    const poolInstance = await initializeDatabase({
      connectionString: 'postgresql://test:test@localhost:5432/testdb',
      min: 5,
      max: 25,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 20000,
    });

    expect(poolInstance).toBeDefined();
    expect(getDatabase()).toBe(poolInstance);

    const metrics = getPoolMetrics();
    expect(metrics.totalCount).toBe(5);
    expect(metrics.idleCount).toBe(3);
    expect(metrics.activeCount).toBe(2);
    expect(metrics.waitingCount).toBe(0);
  });

  it('should prevent re-initialization if pool already exists', async () => {
    const p1 = await initializeDatabase();
    const p2 = await initializeDatabase();
    expect(p1).toBe(p2);
  });

  it('should execute queries through pool with timing and circuit breaker', async () => {
    await initializeDatabase();

    const res = await query('SELECT * FROM "User" WHERE id = $1', ['user_123'], {
      queryName: 'find_user',
    });

    expect(res.rows).toEqual([{ id: 1, val: 'query_res' }]);
    expect(res.rowCount).toBe(1);
  });

  it('should cache queries when useCache is enabled', async () => {
    await initializeDatabase();
    const dbPool = getDatabase();
    (dbPool.query as any).mockClear();

    const res1 = await cachedQuery('SELECT * FROM "Settings" WHERE key = $1', ['app_name']);
    expect(res1.rows).toEqual([{ id: 1, val: 'query_res' }]);
    expect(dbPool.query).toHaveBeenCalledTimes(1);

    // 2nd query with same params should return from cache without querying pool
    const res2 = await cachedQuery('SELECT * FROM "Settings" WHERE key = $1', ['app_name']);
    expect(res2.rows).toEqual([{ id: 1, val: 'query_res' }]);
    expect(dbPool.query).toHaveBeenCalledTimes(1);
  });

  it('should execute prepared statements correctly', async () => {
    await initializeDatabase();
    const ps = createPreparedStatement(
      'get_creator_by_id',
      'SELECT * FROM "Creator" WHERE id = $1',
      ['c_1']
    );

    const res = await executePreparedStatement(ps);
    expect(res.rows).toEqual([{ id: 1, val: 'query_res' }]);
  });

  it('should safely execute withClient and always release client back to pool', async () => {
    await initializeDatabase();
    let capturedClient: any;

    const result = await withClient(async (client) => {
      capturedClient = client;
      const q = await client.query('SELECT 1');
      return q.rows[0];
    });

    expect(result).toEqual({ id: 1, val: 'test' });
    expect(capturedClient.release).toHaveBeenCalled();
  });

  it('should release client even when withClient callback throws error', async () => {
    await initializeDatabase();
    let capturedClient: any;

    await expect(
      withClient(async (client) => {
        capturedClient = client;
        throw new Error('Application error inside checkout');
      })
    ).rejects.toThrow('Application error inside checkout');

    expect(capturedClient.release).toHaveBeenCalled();
  });

  it('should execute transactions with commit and automatic client release', async () => {
    await initializeDatabase();
    let capturedClient: any;

    const txResult = await withTransaction(async (client) => {
      capturedClient = client;
      await client.query('INSERT INTO logs VALUES ($1)', ['event']);
      return 'tx_done';
    });

    expect(txResult).toBe('tx_done');
    expect(capturedClient.query).toHaveBeenCalledWith('BEGIN');
    expect(capturedClient.query).toHaveBeenCalledWith('COMMIT');
    expect(capturedClient.release).toHaveBeenCalled();
  });

  it('should rollback transaction and release client when transaction throws', async () => {
    await initializeDatabase();
    let capturedClient: any;

    await expect(
      withTransaction(async (client) => {
        capturedClient = client;
        await client.query('FAIL_QUERY');
      })
    ).rejects.toThrow('Query execution failed');

    expect(capturedClient.query).toHaveBeenCalledWith('BEGIN');
    expect(capturedClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(capturedClient.release).toHaveBeenCalled();
  });

  it('should return healthy status during checkDatabaseHealth', async () => {
    await initializeDatabase();
    const health = await checkDatabaseHealth();

    expect(health.status).toBe('healthy');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.pool.totalCount).toBe(5);
    expect(health.circuitBreaker.state).toBe('CLOSED');
  });

  it('should report unhealthy status if circuit breaker is OPEN', async () => {
    await initializeDatabase();
    const cb = getCircuitBreaker();
    cb.trip();

    const health = await checkDatabaseHealth();
    expect(health.status).toBe('unhealthy');
    expect(health.error).toContain('Circuit breaker is OPEN');
  });

  it('should handle concurrent queries properly', async () => {
    await initializeDatabase();

    const queries = Array.from({ length: 10 }, (_, i) =>
      query('SELECT $1::int AS idx', [i])
    );

    const results = await Promise.all(queries);
    expect(results).toHaveLength(10);
  });
});
