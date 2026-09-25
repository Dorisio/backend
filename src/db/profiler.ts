import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { explainQuery, QueryPlanResult } from './query-optimizer';

export interface SlowQueryRecord {
  id: string;
  queryName?: string;
  sql: string;
  params?: unknown[];
  durationMs: number;
  thresholdMs: number;
  timestamp: string;
  exceededByMs: number;
}

export interface DetailedQueryProfile {
  queryName?: string;
  sql: string;
  executionDurationMs: number;
  isWithinSLA: boolean;
  slaLimitMs: number;
  planResult?: QueryPlanResult;
  timestamp: string;
}

export class QueryProfiler {
  private slowQueryHistory: SlowQueryRecord[] = [];
  private readonly maxHistorySize: number;
  private slowQueryThresholdMs: number;

  constructor(options: { slowQueryThresholdMs?: number; maxHistorySize?: number } = {}) {
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 100;
    this.maxHistorySize = options.maxHistorySize ?? 100;
  }

  public setSlowQueryThreshold(thresholdMs: number): void {
    this.slowQueryThresholdMs = thresholdMs;
  }

  public getSlowQueryThreshold(): number {
    return this.slowQueryThresholdMs;
  }

  public checkSLA(durationMs: number, slaLimitMs: number = this.slowQueryThresholdMs): boolean {
    return durationMs <= slaLimitMs;
  }

  public recordQueryExecution(
    queryName: string | undefined,
    sql: string,
    params: unknown[] | undefined,
    durationMs: number
  ): void {
    if (durationMs >= this.slowQueryThresholdMs) {
      const record: SlowQueryRecord = {
        id: `sq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        queryName,
        sql,
        params,
        durationMs,
        thresholdMs: this.slowQueryThresholdMs,
        timestamp: new Date().toISOString(),
        exceededByMs: Math.round((durationMs - this.slowQueryThresholdMs) * 100) / 100,
      };

      if (this.slowQueryHistory.length >= this.maxHistorySize) {
        this.slowQueryHistory.shift();
      }
      this.slowQueryHistory.push(record);

      logger.warn(
        {
          id: record.id,
          queryName: record.queryName,
          durationMs: record.durationMs,
          thresholdMs: record.thresholdMs,
          exceededByMs: record.exceededByMs,
        },
        `Query execution exceeded SLA threshold (${durationMs.toFixed(2)}ms >= ${this.slowQueryThresholdMs}ms)`
      );
    }
  }

  public async profileQueryPlan(
    executor: Pool | PoolClient,
    sql: string,
    params: unknown[] = [],
    queryName?: string
  ): Promise<DetailedQueryProfile> {
    const startTime = Date.now();
    const planResult = await explainQuery(executor, sql, params, true);
    const durationMs = Date.now() - startTime;

    return {
      queryName,
      sql,
      executionDurationMs: durationMs,
      isWithinSLA: this.checkSLA(durationMs),
      slaLimitMs: this.slowQueryThresholdMs,
      planResult,
      timestamp: new Date().toISOString(),
    };
  }

  public getSlowQueryHistory(): SlowQueryRecord[] {
    return [...this.slowQueryHistory];
  }

  public clearSlowQueryHistory(): void {
    this.slowQueryHistory = [];
  }
}

export const queryProfiler = new QueryProfiler();
