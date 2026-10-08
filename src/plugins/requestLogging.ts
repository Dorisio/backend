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

import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  REQUEST_ID_HEADER,
  getRequestId,
  resolveRequestId,
  runWithRequestContext,
  setRequestIdResponseHeader,
} from '../lib/requestContext';

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const incoming = request.headers[REQUEST_ID_HEADER.toLowerCase()];
    const requestId = resolveRequestId(incoming, randomUUID);

    reply.header(REQUEST_ID_HEADER, requestId);

    // Fastify hooks run within the same async execution context as the
    // rest of that request's lifecycle, so establishing the
    // AsyncLocalStorage context here makes it visible to every later
    // hook, the route handler, and anything they call transitively.
    runWithRequestContext({ requestId }, done);
  });

  // Fastify can produce validation and 404 responses before a route handler;
  // set the header at send time as well so every response is correlated.
  app.addHook('onSend', async (request, reply) => {
    setRequestIdResponseHeader(reply, getRequestId() ?? request.id);
  });
}
