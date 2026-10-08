import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { QueryAnalysisService, SLOW_QUERY_THRESHOLD_MS } from '../query-analysis.service';

// Mock pool
const createMockPool = (): Pool => {
  return {
    query: vi.fn(),
  } as unknown as Pool;
};

describe('QueryAnalysisService', () => {
  let service: QueryAnalysisService;
  let mockPool: Pool;

  beforeEach(() => {
    mockPool = createMockPool();
    service = new QueryAnalysisService(mockPool);
  });

  describe('enablePgStatStatements', () => {
    it('should enable pg_stat_statements extension', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], command: '', rowCount: 0, oid: 0, fields: [] });

      const result = await service.enablePgStatStatements();

      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    });

    it('should return false on error', async () => {
      vi.mocked(mockPool.query).mockRejectedValue(new Error('Permission denied'));

      const result = await service.enablePgStatStatements();

      expect(result).toBe(false);
    });
  });

  describe('isPgStatStatementsEnabled', () => {
    it('should return true when extension is enabled', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ enabled: true }],
        command: '', rowCount: 1, oid: 0, fields: []
      });

      const result = await service.isPgStatStatementsEnabled();

      expect(result).toBe(true);
    });

    it('should return false when extension is not enabled', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ enabled: false }],
        command: '', rowCount: 1, oid: 0, fields: []
      });

      const result = await service.isPgStatStatementsEnabled();

      expect(result).toBe(false);
    });

    it('should return false on error', async () => {
      vi.mocked(mockPool.query).mockRejectedValue(new Error('Connection error'));

      const result = await service.isPgStatStatementsEnabled();

      expect(result).toBe(false);
    });
  });

  describe('getSlowQueries', () => {
    it('should return empty array if pg_stat_statements not enabled', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ enabled: false }],
        command: '', rowCount: 1, oid: 0, fields: []
      });

      const result = await service.getSlowQueries();

      expect(result).toEqual([]);
    });

    it('should fetch slow queries above threshold', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [
            {
              query: 'SELECT * FROM users WHERE status = $1',
              calls: '1000',
              total_exec_time: '150000',
              mean_exec_time: '150',
              max_exec_time: '500',
              min_exec_time: '50',
              stddev_exec_time: '75',
              rows: '50000',
            },
          ],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const result = await service.getSlowQueries(20);

      expect(result).toHaveLength(1);
      expect(result[0].meanTimeMs).toBe(150);
      expect(result[0].query).toContain('SELECT * FROM users');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE mean_exec_time > $1'),
        [SLOW_QUERY_THRESHOLD_MS, 20]
      );
    });

    it('should use correct threshold (100ms)', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [],
          command: '', rowCount: 0, oid: 0, fields: []
        });

      await service.getSlowQueries();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        [100, 20]
      );
    });
  });

  describe('getTopQueriesByTime', () => {
    it('should fetch queries ordered by total time', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [
            {
              query: 'SELECT * FROM orders',
              calls: '5000',
              total_exec_time: '250000',
              mean_exec_time: '50',
              max_exec_time: '200',
              min_exec_time: '10',
              rows: '100000',
            },
          ],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const result = await service.getTopQueriesByTime(20);

      expect(result).toHaveLength(1);
      expect(result[0].totalTimeMs).toBe(250000);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY total_exec_time DESC'),
        [20]
      );
    });
  });

  describe('getTopQueriesByCalls', () => {
    it('should fetch queries ordered by call count', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [
            {
              query: 'SELECT id FROM cache',
              calls: '10000',
              total_exec_time: '50000',
              mean_exec_time: '5',
              max_exec_time: '20',
              min_exec_time: '1',
              rows: '10000',
            },
          ],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const result = await service.getTopQueriesByCalls(20);

      expect(result).toHaveLength(1);
      expect(result[0].calls).toBe(10000);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY calls DESC'),
        [20]
      );
    });
  });

  describe('identifyMissingIndexes', () => {
    it('should identify tables with high sequential scans', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [
          {
            schemaname: 'public',
            tablename: 'users',
            seq_scan: '5000',
            seq_tup_read: '10000000',
            idx_scan: '100',
            n_live_tup: '50000',
          },
          {
            schemaname: 'public',
            tablename: 'orders',
            seq_scan: '3000',
            seq_tup_read: '5000000',
            idx_scan: '500',
            n_live_tup: '30000',
          },
        ],
        command: '', rowCount: 2, oid: 0, fields: []
      });

      const result = await service.identifyMissingIndexes();

      expect(result).toHaveLength(2);
      expect(result[0].table).toBe('users');
      expect(result[0].estimatedRows).toBe(50000);
      expect(result[0].reason).toContain('5000 sequential scans');
    });

    it('should filter out small tables', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [
          {
            schemaname: 'public',
            tablename: 'small_table',
            seq_scan: '1000',
            seq_tup_read: '500',
            idx_scan: '0',
            n_live_tup: '100', // Too small
          },
        ],
        command: '', rowCount: 1, oid: 0, fields: []
      });

      const result = await service.identifyMissingIndexes();

      expect(result).toHaveLength(0);
    });
  });

  describe('generatePerformanceReport', () => {
    it('should generate comprehensive report', async () => {
      // Mock all required methods
      vi.mocked(mockPool.query)
        // isPgStatStatementsEnabled (called 4 times)
        .mockResolvedValueOnce({ rows: [{ enabled: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ enabled: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ enabled: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ enabled: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        // getSlowQueries
        .mockResolvedValueOnce({
          rows: [{
            query: 'SLOW QUERY',
            calls: '100',
            total_exec_time: '50000',
            mean_exec_time: '500',
            max_exec_time: '1000',
            min_exec_time: '100',
            stddev_exec_time: '200',
            rows: '1000',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        // getTopQueriesByTime
        .mockResolvedValueOnce({
          rows: [{
            query: 'TOP QUERY',
            calls: '1000',
            total_exec_time: '100000',
            mean_exec_time: '100',
            max_exec_time: '500',
            min_exec_time: '10',
            rows: '5000',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        // getTopQueriesByCalls
        .mockResolvedValueOnce({
          rows: [{
            query: 'FREQUENT QUERY',
            calls: '10000',
            total_exec_time: '50000',
            mean_exec_time: '5',
            max_exec_time: '20',
            min_exec_time: '1',
            rows: '10000',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        // identifyMissingIndexes
        .mockResolvedValueOnce({
          rows: [{
            schemaname: 'public',
            tablename: 'users',
            seq_scan: '5000',
            seq_tup_read: '10000000',
            idx_scan: '100',
            n_live_tup: '50000',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const report = await service.generatePerformanceReport();

      expect(report.slowQueries).toHaveLength(1);
      expect(report.topQueriesByTime).toHaveLength(1);
      expect(report.topQueriesByCalls).toHaveLength(1);
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.summary.totalQueryTime).toBeGreaterThan(0);
      expect(report.generatedAt).toBeInstanceOf(Date);
    });
  });

  describe('resetStatistics', () => {
    it('should reset pg_stat_statements', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [],
          command: '', rowCount: 0, oid: 0, fields: []
        });

      const result = await service.resetStatistics();

      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_stat_statements_reset()');
    });

    it('should return false if not enabled', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ enabled: false }],
        command: '', rowCount: 1, oid: 0, fields: []
      });

      const result = await service.resetStatistics();

      expect(result).toBe(false);
    });
  });

  describe('getStatisticsSummary', () => {
    it('should return statistics summary', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [{
            total_calls: '50000',
            total_time: '1500000',
            unique_queries: '250',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const result = await service.getStatisticsSummary();

      expect(result.totalCalls).toBe(50000);
      expect(result.totalTimeMs).toBe(1500000);
      expect(result.avgTimeMs).toBe(30); // 1500000 / 50000
      expect(result.uniqueQueries).toBe(250);
    });

    it('should handle division by zero', async () => {
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({
          rows: [{ enabled: true }],
          command: '', rowCount: 1, oid: 0, fields: []
        })
        .mockResolvedValueOnce({
          rows: [{
            total_calls: '0',
            total_time: '0',
            unique_queries: '0',
          }],
          command: '', rowCount: 1, oid: 0, fields: []
        });

      const result = await service.getStatisticsSummary();

      expect(result.avgTimeMs).toBe(0);
    });
  });
});
