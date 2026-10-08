/**
 * Shared runtime for creator tier enforcement (issue #69).
 *
 * One instance per process wires the pieces together so that every feature —
 * the tier routes, the analytics endpoints, background renewal — sees the same
 * cache, the same limiter and the same buffered usage counters:
 *
 *   - `resolver`  turns a user id into the tier they are entitled to and is
 *                 invalidated whenever a subscription write goes through;
 *   - `limiter`   enforces the per-creator minute/day budget;
 *   - `usage`     buffers month-to-date counters and flushes them in batches;
 *   - `service`   owns the subscription state machine and invoices.
 *
 * Building it here (rather than inside a route module) is what keeps tier
 * changes from being visible on one endpoint and invisible on another.
 */

import { PrismaClient } from '@prisma/client';
import { CreatorTierLimiter, getCreatorTierLimiter } from '../../lib/creator-tier-limits';
import { CreatorTierResolver, type CreatorTierMiddlewareOptions } from '../../middleware/creator-tier';
import { CreatorTierService, CreatorUsageService } from './tier.service';

export interface CreatorTierRuntime {
  resolver: CreatorTierResolver;
  limiter: CreatorTierLimiter;
  usage: CreatorUsageService;
  service: CreatorTierService;
  /** Options bundle for `requireCreator` / `enforceCreatorQuota`. */
  middleware: CreatorTierMiddlewareOptions;
  /** Flushes buffered usage and stops timers. Safe to call more than once. */
  close(): Promise<void>;
}

export interface CreatorTierRuntimeOptions {
  /** Reuse an existing limiter (tests, or a Redis-backed replacement). */
  limiter?: CreatorTierLimiter;
  /** How often buffered usage is written to the database. */
  usageFlushIntervalMs?: number;
  /** How often expired rate-limit windows are dropped. */
  pruneIntervalMs?: number;
  /** Longest a resolved tier may be reused, in milliseconds. */
  resolverTtlMs?: number;
  now?: () => number;
  /** Set to false in tests to flush usage explicitly. */
  autoFlushUsage?: boolean;
  /** Set to false in tests to prune explicitly. */
  autoPrune?: boolean;
}

export function createCreatorTierRuntime(
  prisma: PrismaClient,
  options: CreatorTierRuntimeOptions = {}
): CreatorTierRuntime {
  const limiter = options.limiter ?? getCreatorTierLimiter();
  const resolver = new CreatorTierResolver(prisma, {
    ttlMs: options.resolverTtlMs,
    now: options.now,
  });

  const usage = new CreatorUsageService(prisma, {
    now: options.now,
    flushIntervalMs: options.usageFlushIntervalMs,
    autoFlush: options.autoFlushUsage,
  });

  const service = new CreatorTierService(prisma, {
    now: options.now,
    // A tier change must be visible on the very next request, so the cached
    // tier for that user is dropped instead of waiting for the TTL.
    onTierChanged: (userId) => resolver.invalidate(userId),
  });

  const pruneTimer =
    options.autoPrune === false
      ? null
      : setInterval(() => limiter.prune(), options.pruneIntervalMs ?? 5 * 60_000);
  // Never keep the process alive just to prune counters.
  pruneTimer?.unref?.();

  let closed = false;

  return {
    resolver,
    limiter,
    usage,
    service,
    middleware: { resolver, limiter, recorder: usage },
    async close() {
      if (closed) return;
      closed = true;
      if (pruneTimer) clearInterval(pruneTimer);
      // Buffered counters are usage data the creator may have paid for; lose as
      // little of it as possible on shutdown.
      await usage.flush().catch(() => undefined);
      usage.stop();
    },
  };
}
