import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';
import { replicaQueriesTotal, replicaLagSeconds, replicaFallbacksTotal } from './metrics';

export interface ReplicaHealth { url: string; healthy: boolean; lagSeconds: number; checkedAt: number; }

export class ReadReplicaManager {
  private readonly primary: Pool;
  private readonly replicas: Pool[];
  private readonly health = new Map<Pool, ReplicaHealth>();
  private cursor = 0;

  constructor(options: { primaryUrl?: string; replicaUrls?: string[]; lagToleranceSeconds?: number } = {}) {
    const urls = options.replicaUrls ?? (config.DATABASE_READ_REPLICA_URLS?.split(',').map((u) => u.trim()).filter(Boolean) ?? []);
    this.primary = new Pool({ connectionString: options.primaryUrl ?? config.DATABASE_URL });
    this.replicas = config.DB_REPLICA_ENABLED === false && options.replicaUrls === undefined
      ? []
      : urls.map((connectionString) => new Pool({ connectionString }));
    for (const pool of this.replicas) this.health.set(pool, { url: '', healthy: true, lagSeconds: 0, checkedAt: 0 });
    this.lagToleranceSeconds = options.lagToleranceSeconds ?? config.DB_REPLICA_LAG_TOLERANCE_SECONDS;
  }
  private readonly lagToleranceSeconds: number;

  async checkHealth(): Promise<ReplicaHealth[]> {
    const results: ReplicaHealth[] = [];
    for (const pool of this.replicas) {
      const previous = this.health.get(pool)!;
      try {
        const result = await pool.query<{ lag_seconds: number }>(
          "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())), 0) AS lag_seconds"
        );
        const lagSeconds = Math.max(0, Number(result.rows[0]?.lag_seconds ?? 0));
        const next = { ...previous, healthy: lagSeconds <= this.lagToleranceSeconds, lagSeconds, checkedAt: Date.now() };
        this.health.set(pool, next);
        replicaLagSeconds.set({ replica: next.url || 'replica' }, lagSeconds);
        results.push(next);
      } catch (error) {
        const next = { ...previous, healthy: false, checkedAt: Date.now() };
        this.health.set(pool, next);
        logger.warn({ error }, 'Read replica health check failed');
        results.push(next);
      }
    }
    return results;
  }

  private nextHealthyReplica(): Pool | null {
    if (this.replicas.length === 0) return null;
    for (let i = 0; i < this.replicas.length; i++) {
      const pool = this.replicas[this.cursor++ % this.replicas.length];
      const health = this.health.get(pool);
      if (!health || health.healthy) return pool;
    }
    return null;
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[], options: { readReplica?: boolean } = {}): Promise<QueryResult<R>> {
    const replica = options.readReplica ? this.nextHealthyReplica() : null;
    const pool = replica ?? this.primary;
    try {
      const result = await pool.query<R>(text, values);
      replicaQueriesTotal.inc({ target: replica ? 'replica' : 'primary', status: 'success' });
      return result;
    } catch (error) {
      if (replica) {
        replicaFallbacksTotal.inc();
        replicaQueriesTotal.inc({ target: 'primary', status: 'fallback' });
        logger.warn({ error }, 'Read replica query failed; retrying on primary');
        return this.primary.query<R>(text, values);
      }
      replicaQueriesTotal.inc({ target: 'primary', status: 'error' });
      throw error;
    }
  }

  async withReadClient<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const replica = this.nextHealthyReplica();
    const client = await (replica ?? this.primary).connect();
    try { return await callback(client); } catch (error) {
      if (!replica) throw error;
      replicaFallbacksTotal.inc();
      const primaryClient = await this.primary.connect();
      try { return await callback(primaryClient); } finally { primaryClient.release(); }
    } finally { client.release(); }
  }

  async close(): Promise<void> { await Promise.all([this.primary.end(), ...this.replicas.map((pool) => pool.end())]); }
  getHealth(): ReplicaHealth[] { return [...this.health.values()]; }
}

let manager: ReadReplicaManager | null = null;
export function getReadReplicaManager(): ReadReplicaManager { return manager ??= new ReadReplicaManager(); }
export function setReadReplicaManager(value: ReadReplicaManager | null): void { manager = value; }
