/**
 * Establishes the per-request AsyncLocalStorage context (#26) that
 * utils/logger.ts's Pino mixin reads from. Must be registered as early
 * as possible — every hook/handler that runs after `onRequest` for a
 * given request executes inside `runWithRequestContext`, so any log call
 * anywhere in that request's call stack gets requestId (and userId, once
 * authMiddleware sets it) automatically.
 *
 * Honors an incoming X-Request-Id header (so a request already carrying
 * a correlation ID from an upstream proxy/gateway keeps it end-to-end)
 * and always echoes the resolved ID back on the response.
 */

import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runWithRequestContext } from '../lib/requestContext';

const REQUEST_ID_HEADER = 'x-request-id';

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : randomUUID();

    reply.header(REQUEST_ID_HEADER, requestId);

    // Fastify hooks run within the same async execution context as the
    // rest of that request's lifecycle, so establishing the
    // AsyncLocalStorage context here makes it visible to every later
    // hook, the route handler, and anything they call transitively.
    runWithRequestContext({ requestId }, done);
  });
}
