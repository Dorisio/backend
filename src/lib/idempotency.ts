/**
 * Request idempotency (#24).
 *
 * Opt-in per route (only applied where a route config includes
 * `idempotencyPreHandler`/`idempotencyOnSend`) via the client-provided
 * `Idempotency-Key` header — a request with no such header is never
 * touched by this module, matching the common Stripe-style convention
 * where idempotency is the caller's choice, not forced globally.
 *
 * Built on cacheService's existing `acquireLock`/`releaseLock` (SET NX EX)
 * and `get`/`set` — no new Redis connection or locking primitive needed.
 */

import { FastifyReply, FastifyRequest } from 'fastify';
import { cacheService } from './cache';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h, per issue #24's requirement
const LOCK_WAIT_RETRY_MS = 100;
const LOCK_WAIT_MAX_ATTEMPTS = 20; // ~2s total, bounded so a stuck peer request can't hang this one forever

interface CachedIdempotentResponse {
  statusCode: number;
  body: unknown;
}

function cacheKeyFor(request: FastifyRequest, idempotencyKey: string): string {
  // Scoped per method+route (not just the raw key) so the same
  // Idempotency-Key value reused across different endpoints — a real
  // possibility if a client generates one key per logical "operation" — can
  // never return one endpoint's cached response for another's request.
  // Matches the issue's "different idempotency strategies per endpoint".
  //
  // Also scoped per authenticated user (when present — this preHandler
  // must run after authMiddleware for that to be populated): two different
  // users independently choosing the same client-generated key value must
  // never see each other's cached response.
  const userId = (request as FastifyRequest & { user?: { id?: string } }).user?.id ?? 'anonymous';
  return `idempotency:${userId}:${request.method}:${request.routeOptions?.url ?? request.url}:${idempotencyKey}`;
}

/**
 * preHandler: on an Idempotency-Key hit, sends the cached response and
 * short-circuits before the route handler runs. On a miss, acquires a
 * per-key lock so two concurrent requests with the same key can't both
 * execute the underlying (side-effecting) handler — the loser waits
 * briefly for the winner's cached result rather than proceeding.
 */
export async function idempotencyPreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return; // No key provided — not an idempotent request, proceed normally.
  }

  const cacheKey = cacheKeyFor(request, idempotencyKey);
  const cached = await cacheService.get<CachedIdempotentResponse>(cacheKey);
  if (cached) {
    request.log.info(
      { idempotencyKey, cacheKey },
      'Idempotency hit — returning cached response'
    );
    reply.header('Idempotency-Replayed', 'true');
    reply.code(cached.statusCode).send(cached.body);
    return;
  }

  const lockKey = `lock:${cacheKey}`;
  const acquired = await cacheService.acquireLock(lockKey);

  if (!acquired) {
    // Another request with the same key is in flight right now. Poll
    // briefly for its cached result instead of letting this request
    // execute the handler too (that's exactly the duplicate-side-effect
    // race this feature exists to prevent).
    for (let attempt = 0; attempt < LOCK_WAIT_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_RETRY_MS));
      const retryCached = await cacheService.get<CachedIdempotentResponse>(cacheKey);
      if (retryCached) {
        reply.header('Idempotency-Replayed', 'true');
        reply.code(retryCached.statusCode).send(retryCached.body);
        return;
      }
    }
    reply.code(409).send({
      error: 'A request with this Idempotency-Key is already being processed',
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
    return;
  }

  // Stash for onSend to cache the result and release the lock once the
  // handler has actually produced a response.
  (request as FastifyRequest & { idempotencyCacheKey?: string; idempotencyLockKey?: string }).idempotencyCacheKey =
    cacheKey;
  (request as FastifyRequest & { idempotencyLockKey?: string }).idempotencyLockKey = lockKey;
}

/**
 * onSend: caches the response the handler just produced (if this request
 * went through idempotencyPreHandler and acquired a lock) and releases
 * that lock. Must be paired with idempotencyPreHandler on the same route —
 * registering one without the other leaves either a lock that's never
 * released or a response that's never cached.
 */
export async function idempotencyOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  const req = request as FastifyRequest & {
    idempotencyCacheKey?: string;
    idempotencyLockKey?: string;
  };
  if (!req.idempotencyCacheKey || !req.idempotencyLockKey) {
    return payload;
  }

  try {
    // Only cache successful responses — a 4xx/5xx should be retryable by
    // the client with the same key, not permanently pinned as "the" result.
    if (reply.statusCode < 400) {
      let body: unknown = payload;
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload);
        } catch {
          // Non-JSON payload — cache the raw string as-is.
        }
      }
      await cacheService.set(
        req.idempotencyCacheKey,
        { statusCode: reply.statusCode, body },
        DEFAULT_TTL_SECONDS
      );
    }
  } finally {
    await cacheService.releaseLock(req.idempotencyLockKey);
  }

  return payload;
}
