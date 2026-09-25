/**
 * API versioning strategy (#25).
 *
 * All 95 existing routes already carry a version in their path
 * (`/api/v1/...`) — that path-prefix convention IS the versioning
 * mechanism, and this module doesn't change any of those paths (rewriting
 * 95 routes across every domain to some new versioning abstraction would
 * be a large, risky refactor for a live payments backend, disproportionate
 * to what's actually needed here).
 *
 * What was actually missing, and what this adds:
 *  - An explicit, validated list of versions the API currently supports,
 *    so a client that sends a bogus `API-Version` header gets a real 400
 *    instead of silently falling through.
 *  - A `deprecateRoute()` helper any route can opt into to add RFC 8594
 *    Sunset + Deprecation + Warning headers once that route is actually
 *    being retired — nothing is deprecated yet, so nothing calls it yet,
 *    but the mechanism exists for when something needs to be.
 *  - Per-version request metrics (dorisio_api_version_requests_total),
 *    so a real deprecation decision is based on observed traffic instead
 *    of guessing whether v1 clients have migrated.
 */

import { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from 'fastify';
import { apiVersionCounter } from '../lib/metrics';

export const SUPPORTED_API_VERSIONS = ['1'] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

const API_VERSION_HEADER = 'api-version';

/** Extracts the version from the `/api/v<N>/...` path prefix, if present. */
function versionFromPath(url: string): string | null {
  const match = url.match(/^\/api\/v(\d+)\//);
  return match ? match[1] : null;
}

/**
 * Registers global request-level version handling:
 *  - Rejects an explicit `API-Version` header naming an unsupported
 *    version with 400 (a client that got the version wrong should find
 *    out immediately, not get routed to the wrong or default handler).
 *  - Records a metric for the resolved version (header value if present
 *    and valid, else the path-prefix version, else "unknown") on every
 *    request, for deprecation-planning visibility.
 */
export function registerApiVersioning(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const headerVersion = request.headers[API_VERSION_HEADER];

    if (typeof headerVersion === 'string' && headerVersion.trim()) {
      if (!(SUPPORTED_API_VERSIONS as readonly string[]).includes(headerVersion.trim())) {
        reply.code(400).send({
          error: `Unsupported API-Version: ${headerVersion}. Supported versions: ${SUPPORTED_API_VERSIONS.join(', ')}`,
          code: 'UNSUPPORTED_API_VERSION',
        });
        return;
      }
    }

    const resolvedVersion =
      (typeof headerVersion === 'string' && headerVersion.trim()) ||
      versionFromPath(request.url) ||
      'unknown';

    apiVersionCounter.inc({ version: resolvedVersion, path: request.routeOptions?.url ?? request.url });
  });
}

export interface DeprecationOptions {
  /** ISO 8601 date the route will stop working (RFC 8594 Sunset header). */
  sunsetDate: string;
  /** Human-readable migration guidance, sent in the Warning header. */
  message: string;
  /** Optional link to a migration guide, sent as a Link header with rel="deprecation". */
  migrationGuideUrl?: string;
}

/**
 * Route-level onSend hook adding standard deprecation headers. Attach via
 * a route's `onSend` option:
 *
 *   app.get('/api/v1/old-thing', {
 *     onSend: deprecateRoute({
 *       sunsetDate: '2027-01-01',
 *       message: 'Use GET /api/v2/new-thing instead',
 *       migrationGuideUrl: 'https://docs.example.com/migrate-old-thing',
 *     }),
 *   }, handler);
 */
export function deprecateRoute(options: DeprecationOptions): onSendHookHandler {
  return async (_request, reply, payload) => {
    reply.header('Deprecation', 'true');
    reply.header('Sunset', options.sunsetDate);
    reply.header('Warning', `299 - "${options.message}"`);
    if (options.migrationGuideUrl) {
      reply.header('Link', `<${options.migrationGuideUrl}>; rel="deprecation"`);
    }
    return payload;
  };
}
