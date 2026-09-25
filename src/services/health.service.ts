import { logger } from '../utils/logger';
import { getStellarClient } from '../lib/stellar/client';

/**
 * Health check service
 *
 * Provides pure(ish), independently-testable building blocks for the
 * `/health` (liveness) and `/readiness` endpoints:
 *  - per-dependency checks (database, cache, external APIs) that are
 *    timeout-bound so a hung dependency cannot hang the whole probe
 *  - a small module-level service lifecycle state machine
 *    (starting -> ready -> shutting_down) used to gate readiness during
 *    startup and graceful shutdown
 */

export type DependencyStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface DependencyCheckResult {
  status: DependencyStatus;
  latencyMs?: number;
  message?: string;
  critical: boolean;
}

export type ServiceState = 'starting' | 'ready' | 'shutting_down';

// Default per-check timeout. Kept short so probes stay fast and a hung
// dependency doesn't block a load balancer / orchestrator health check.
export const DEFAULT_CHECK_TIMEOUT_MS = 2000;

/**
 * Runs a dependency check with a hard timeout so a hung/slow dependency
 * can never make a health probe hang indefinitely.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Minimal shape of the Prisma client this check needs: a tagged-template
 * raw query method returning a thenable. `PrismaClient['$queryRaw']`
 * returns a branded `PrismaPromise`, which is awkward for test doubles to
 * satisfy structurally, so this narrows to just "awaitable" - the real
 * `PrismaClient` still satisfies it since `PrismaPromise` is a `Promise`.
 */
export type DatabaseClient = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/**
 * Checks database connectivity via a lightweight query.
 * Critical dependency: payment orchestration cannot function without it.
 */
export async function checkDatabaseHealth(
  prisma: DatabaseClient,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<DependencyCheckResult> {
  const startedAt = Date.now();

  try {
    await withTimeout(
      () => prisma.$queryRaw`SELECT 1`,
      timeoutMs,
      'Database health check timed out'
    );

    return {
      status: 'healthy',
      latencyMs: Date.now() - startedAt,
      critical: true,
    };
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Unknown database error',
      critical: true,
    };
  }
}

/**
 * Minimal shape of the Redis client this check needs. Structurally
 * compatible with the `redis` (node-redis v4) client exported from
 * `src/lib/queue.ts`, which this check reuses rather than opening a new
 * connection. Kept as a small structural interface (rather than importing
 * `RedisClientType` from `redis`) so callers can pass the shared client,
 * a mock, or any object shaped like this without generic-parameter
 * mismatches.
 */
export interface CacheClient {
  isOpen: boolean;
  ping: () => Promise<string>;
}

/**
 * Checks cache (Redis) connectivity via PING.
 * Critical dependency: job queues (bullmq) rely on Redis being reachable.
 */
export async function checkCacheHealth(
  cache: CacheClient,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<DependencyCheckResult> {
  const startedAt = Date.now();

  try {
    if (!cache.isOpen) {
      return {
        status: 'unhealthy',
        latencyMs: Date.now() - startedAt,
        message: 'Redis client is not connected',
        critical: true,
      };
    }

    await withTimeout(() => cache.ping(), timeoutMs, 'Cache health check timed out');

    return {
      status: 'healthy',
      latencyMs: Date.now() - startedAt,
      critical: true,
    };
  } catch (error) {
    logger.error({ error }, 'Cache health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Unknown cache error',
      critical: true,
    };
  }
}

/**
 * Minimal shape of the Stellar client this check needs.
 */
export type StellarHealthClient = Pick<
  ReturnType<typeof getStellarClient>,
  'getNetworkStatus'
>;

/**
 * Checks connectivity to the configured Stellar Horizon/RPC endpoint by
 * fetching the latest ledger, which is a cheap, side-effect-free read.
 *
 * Treated as non-critical: outbound Stellar network calls (submitting
 * transactions, streaming) are handled elsewhere, and a transient Horizon
 * blip shouldn't take the whole service out of rotation. It is still
 * surfaced in the readiness response for observability.
 */
export async function checkStellarHealth(
  stellarClient: StellarHealthClient,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<DependencyCheckResult> {
  const startedAt = Date.now();

  try {
    await withTimeout(
      () => stellarClient.getNetworkStatus(),
      timeoutMs,
      'Stellar network health check timed out'
    );

    return {
      status: 'healthy',
      latencyMs: Date.now() - startedAt,
      critical: false,
    };
  } catch (error) {
    logger.error({ error }, 'Stellar network health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Unknown Stellar network error',
      critical: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Service lifecycle state machine
// ---------------------------------------------------------------------------
//
// Tracks startup/shutdown so `/readiness` can fail fast (503) before
// dependencies have been confirmed healthy, and again once a graceful
// shutdown has begun, so a load balancer stops routing new traffic before
// the process actually exits.

let serviceState: ServiceState = 'starting';

export function getServiceState(): ServiceState {
  return serviceState;
}

export function setServiceState(state: ServiceState): void {
  logger.info({ from: serviceState, to: state }, 'Service state transition');
  serviceState = state;
}

/** Test-only helper to reset module state between test cases. */
export function resetServiceState(): void {
  serviceState = 'starting';
}
