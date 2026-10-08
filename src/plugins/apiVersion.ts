/** API version negotiation and lifecycle helpers. */
import { FastifyInstance, FastifyRequest, onSendHookHandler } from 'fastify';
import { apiVersionCounter } from '../lib/metrics';
import { config } from '../config';

export const SUPPORTED_API_VERSIONS = ['1', '2'] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];
const VERSION_HEADER = 'api-version';

function versionFromPath(url: string): string | null {
  const match = url.match(/^\/api\/v(\d+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function versionFromAccept(accept: string | undefined): string | null {
  const match = accept?.match(/application\/vnd\.dorisio\.v(\d+)\+json/i);
  return match?.[1] ?? null;
}

export function resolveApiVersion(request: Pick<FastifyRequest, 'url' | 'headers'>): string {
  const explicit = request.headers[VERSION_HEADER];
  return (typeof explicit === 'string' && explicit.trim()) ||
    versionFromPath(request.url) ||
    versionFromAccept(request.headers.accept) ||
    '1';
}

export function isSupportedApiVersion(version: string): version is ApiVersion {
  return (SUPPORTED_API_VERSIONS as readonly string[]).includes(version);
}

export function registerApiVersioning(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const headerVersion = request.headers[VERSION_HEADER];
    const pathVersion = versionFromPath(request.url);
    const acceptVersion = versionFromAccept(request.headers.accept);
    const versions = [headerVersion, pathVersion, acceptVersion]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    if (versions.some((version) => !isSupportedApiVersion(version))) {
      reply.code(400).send({
        error: `Unsupported API version. Supported versions: ${SUPPORTED_API_VERSIONS.map((v) => `v${v}`).join(', ')}`,
        code: 'UNSUPPORTED_API_VERSION',
        supportedVersions: SUPPORTED_API_VERSIONS.map((v) => `v${v}`),
      });
      return;
    }
    if (new Set(versions).size > 1) {
      reply.code(400).send({ error: 'Conflicting API version selectors', code: 'CONFLICTING_API_VERSION' });
      return;
    }

    const version = resolveApiVersion(request);
    reply.header('API-Version', version);
    reply.header('Vary', 'Accept, API-Version');
    apiVersionCounter.inc({ version, path: request.routeOptions?.url ?? request.url });
  });
}

export interface DeprecationOptions {
  sunsetDate: string;
  message: string;
  migrationGuideUrl?: string;
}

export function deprecateRoute(options: DeprecationOptions): onSendHookHandler {
  return async (_request, reply, payload) => {
    reply.header('Deprecation', 'true');
    reply.header('Sunset', options.sunsetDate);
    reply.header('Warning', `299 - "${options.message}"`);
    reply.header('Link', `<${options.migrationGuideUrl ?? '/docs/api-versioning'}>; rel="deprecation"`);
    return payload;
  };
}

/** Version-scoped feature rollout helper. */
export function isVersionFeatureEnabled(version: string, feature: string): boolean {
  const key = `FEATURE_${feature.toUpperCase()}_V${version}` as keyof typeof config;
  const value = config[key];
  return typeof value === 'boolean' ? value : true;
}
