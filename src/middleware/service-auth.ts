/**
 * Internal service-to-service authentication (#140).
 *
 * Credentials are configuration-backed and are intentionally independent of
 * user JWT authentication. API keys are compared with a fixed-size SHA-256
 * digest and timingSafeEqual; all configured credentials are examined before
 * returning, avoiding an identity oracle. Key material is never attached to
 * the request or emitted in logs.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../config';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';
import { registerServiceGuard } from './auth-guards';

export interface ServiceIdentity {
  id: string;
  name?: string;
  scopes: string[];
  roles: string[];
  keyId?: string;
  keyVersion?: 'current' | 'previous';
  expiresAt?: string;
  mtls?: boolean;
}

interface ServiceKeyRecord {
  id?: string;
  serviceId?: string;
  service?: string;
  name?: string;
  key?: string;
  currentKey?: string;
  previousKey?: string;
  previousKeys?: Array<string | { key: string; expiresAt?: string }>;
  scopes?: string[];
  roles?: string[];
  expiresAt?: string;
  previousKeyExpiresAt?: string;
}

const HEADER = 'x-internal-api-key';
const currentConfig = () => getConfig();

const authScheme = /^ApiKey\s+([^\s]+)$/i;

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function parseConfiguredKeys(): ServiceKeyRecord[] {
  const raw = currentConfig().INTERNAL_SERVICE_API_KEYS;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ServiceKeyRecord => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as ServiceKeyRecord;
      return typeof item.key === 'string' || typeof item.currentKey === 'string';
    });
  } catch {
    return [];
  }
}

function isExpired(value?: string): boolean {
  return Boolean(value && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()));
}

function identity(
  record: ServiceKeyRecord,
  keyVersion: 'current' | 'previous',
  expiresAt?: string,
  mtls = false
): ServiceIdentity {
  return {
    id: record.serviceId ?? record.id ?? record.service ?? 'unknown',
    name: record.name,
    scopes: Array.isArray(record.scopes) ? [...record.scopes] : [],
    roles: Array.isArray(record.roles) ? [...record.roles] : [],
    keyId: record.id,
    keyVersion,
    expiresAt,
    mtls,
  };
}

function extractApiKey(request: FastifyRequest): { key?: string; malformed: boolean } {
  const direct = request.headers[HEADER];
  const authorization = request.headers.authorization;
  if (direct !== undefined) {
    if (typeof direct !== 'string' || !direct || /\s/.test(direct)) return { malformed: true };
    return { key: direct, malformed: false };
  }
  if (authorization === undefined) return { malformed: false };
  if (typeof authorization !== 'string') return { malformed: true };
  const match = authScheme.exec(authorization.trim());
  return match ? { key: match[1], malformed: false } : { malformed: true };
}

function audit(
  event: 'accepted' | 'rejected',
  request: FastifyRequest,
  details: Record<string, unknown> = {}
): void {
  // Deliberately allow only identity/decision metadata. Never pass headers or key material.
  logger.warn(
    {
      event: `service_auth.${event}`,
      requestId: request.id,
      method: request.method,
      url: request.url,
      ...details,
    },
    'Internal service authentication event'
  );
}

export function verifyServiceMtls(request: FastifyRequest): boolean {
  if (!currentConfig().INTERNAL_SERVICE_MTLS_ENABLED) return true;
  const socket = request.raw.socket as typeof request.raw.socket & {
    authorized?: boolean;
    encrypted?: boolean;
    getPeerCertificate?: () => { fingerprint256?: string; subject?: { CN?: string } };
  };
  // Headers such as X-Client-Cert are intentionally ignored. Only the TLS socket
  // supplied by Node can establish peer certificate provenance.
  if (
    !socket.encrypted ||
    socket.authorized !== true ||
    typeof socket.getPeerCertificate !== 'function'
  )
    return false;
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.fingerprint256) return false;
  const fingerprints = (currentConfig().INTERNAL_SERVICE_MTLS_FINGERPRINTS ?? '')
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  const subjects = (currentConfig().INTERNAL_SERVICE_MTLS_SUBJECTS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (fingerprints.length === 0 && subjects.length === 0) return true;
  return (
    fingerprints.includes(cert.fingerprint256.toUpperCase()) ||
    Boolean(cert.subject?.CN && subjects.includes(cert.subject.CN))
  );
}

export const serviceAuthMiddleware = registerServiceGuard(
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!currentConfig().INTERNAL_SERVICE_AUTH_ENABLED) {
      audit('rejected', request, { reason: 'disabled' });
      throw new UnauthorizedError('Internal service authentication is unavailable');
    }
    const parsed = extractApiKey(request);
    if (parsed.malformed || !parsed.key) {
      audit('rejected', request, {
        reason: parsed.malformed ? 'malformed_credentials' : 'missing_credentials',
      });
      throw new UnauthorizedError('Invalid service credentials');
    }
    const records = parseConfiguredKeys();
    let matched: ServiceIdentity | undefined;
    // Do not stop at the first match: compare every configured key.
    for (const record of records) {
      const current = record.key ?? record.currentKey;
      if (current && !isExpired(record.expiresAt) && safeEqual(parsed.key, current))
        matched = identity(record, 'current', record.expiresAt);
      const previous = [
        ...(record.previousKeys ?? []),
        ...(record.previousKey
          ? [{ key: record.previousKey, expiresAt: record.previousKeyExpiresAt }]
          : []),
      ];
      for (const previousEntry of previous) {
        const value = typeof previousEntry === 'string' ? previousEntry : previousEntry.key;
        const expiresAt =
          typeof previousEntry === 'string' ? record.previousKeyExpiresAt : previousEntry.expiresAt;
        if (value && !isExpired(expiresAt) && safeEqual(parsed.key, value))
          matched = identity(record, 'previous', expiresAt);
      }
    }
    if (!matched || !verifyServiceMtls(request)) {
      audit('rejected', request, {
        reason: matched ? 'mtls_failed' : 'invalid_or_expired_credentials',
      });
      throw new UnauthorizedError('Invalid service credentials');
    }
    matched.mtls = currentConfig().INTERNAL_SERVICE_MTLS_ENABLED;
    request.service = Object.freeze(matched);
    audit('accepted', request, {
      serviceId: matched.id,
      keyId: matched.keyId,
      keyVersion: matched.keyVersion,
      mtls: matched.mtls,
    });
  }
);

export const requireServiceAuth = serviceAuthMiddleware;

export function requireServiceScope(scope: string) {
  return registerServiceGuard(
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await serviceAuthMiddleware(request, reply);
      if (!request.service?.scopes.includes(scope))
        throw new ForbiddenError('Insufficient service scope');
    }
  );
}

export function requireServiceRole(role: string) {
  return registerServiceGuard(
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await serviceAuthMiddleware(request, reply);
      if (!request.service?.roles.includes(role))
        throw new ForbiddenError('Insufficient service role');
    }
  );
}

export function requireServiceScopeOrRole(options: { scopes?: string[]; roles?: string[] }) {
  return registerServiceGuard(
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await serviceAuthMiddleware(request, reply);
      const scopeOk = (options.scopes ?? []).some((scope) =>
        request.service?.scopes.includes(scope)
      );
      const roleOk = (options.roles ?? []).some((role) => request.service?.roles.includes(role));
      if (!scopeOk && !roleOk) throw new ForbiddenError('Insufficient service permissions');
    }
  );
}

/** Optional hook for applications that want a single explicit registration point. */
export function registerServiceAuthAuditHooks(_app: FastifyInstance): void {
  // Authentication events are emitted by the guard after identity resolution.
}

declare module 'fastify' {
  interface FastifyRequest {
    service?: ServiceIdentity;
  }
  interface FastifyInstance {
    serviceAuth?: typeof serviceAuthMiddleware;
  }
}
