import { FastifyReply, FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  assertNotBlockedByFailures,
  recordValidationFailure,
  validationFailureKey,
} from '../lib/failure-limiter';

/**
 * Centralized request validation & sanitization.
 *
 * Every route should validate its input at the boundary — before any service or
 * database call — using a schema per request location (`body`, `query`,
 * `params`). Parsed (and sanitized) values are written back onto the request so
 * downstream code only ever sees trusted data.
 */

export type ValidationTarget = 'body' | 'query' | 'params';

export interface RequestValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export interface RequestValidationErrorDetails {
  issues: ValidationIssue[];
}

/**
 * Thrown when a request fails schema validation. Carries field level `details`
 * so clients can render precise error messages, while the top level message
 * stays generic and safe.
 */
export class RequestValidationError extends AppError {
  public readonly details: RequestValidationErrorDetails;

  constructor(issues: ValidationIssue[]) {
    super(400, 'VALIDATION_ERROR', 'The request data is invalid');
    this.name = 'RequestValidationError';
    this.details = { issues };
  }
}

export interface SanitizeOptions {
  /** Collapse runs of whitespace (including newlines) into single spaces. */
  collapseWhitespace?: boolean;
  /** Strip HTML tags and dangerous URL schemes. */
  stripHtml?: boolean;
}

// Control characters that have no place in user input (allows \t \n \r).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_TAGS = /<\/?[a-z][^>]*>/gi;
const DANGEROUS_SCHEMES = /(javascript|vbscript|data)\s*:/gi;

/**
 * Sanitizes a single string: removes control characters, strips HTML tags and
 * dangerous URL schemes, and trims surrounding whitespace. Sanitization is an
 * allowlist-oriented normalization step applied *before* validation.
 */
export function sanitizeString(input: string, options: SanitizeOptions = {}): string {
  const { collapseWhitespace = false, stripHtml = true } = options;

  let value = input.replace(CONTROL_CHARS, '');

  if (stripHtml) {
    value = value.replace(HTML_TAGS, '').replace(DANGEROUS_SCHEMES, '');
  }

  if (collapseWhitespace) {
    value = value.replace(/\s+/g, ' ');
  }

  return value.trim();
}

/**
 * Recursively sanitizes string values within plain objects and arrays. Non
 * string primitives are returned untouched.
 */
export function sanitizeValue<T>(value: T, options: SanitizeOptions = {}): T {
  if (typeof value === 'string') {
    return sanitizeString(value, options) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeValue(item, options);
    }
    return result as unknown as T;
  }

  return value;
}

/**
 * Heuristics for spotting common injection attempts in rejected input. Used for
 * security logging only — never for blocking (an allowlist schema is the
 * authority).
 */
export function detectSuspiciousInput(value: unknown): boolean {
  if (typeof value === 'string') {
    return /(<\s*script|on\w+\s*=|union\s+select|select\s+.*\s+from|'\s*or\s*'?\d|--\s|;\s*drop\s+table|\$where|\{\s*"\$ne)/i.test(
      value
    );
  }

  if (Array.isArray(value)) {
    return value.some(detectSuspiciousInput);
  }

  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(detectSuspiciousInput);
  }

  return false;
}

/**
 * Compiled schema cache. Zod schemas are cheap to clone but compiling them for
 * every request adds up under load, so we memoize by schema identity/version.
 */
const compiledSchemaCache = new LRUCache<ZodSchema, ZodSchema>({
  max: 500,
});

export function compileSchema(schema: ZodSchema): ZodSchema {
  const cached = compiledSchemaCache.get(schema);
  if (cached) {
    return cached;
  }
  compiledSchemaCache.set(schema, schema);
  return schema;
}

export function clearSchemaCache(): void {
  compiledSchemaCache.clear();
}

export function getSchemaCacheSize(): number {
  return compiledSchemaCache.size;
}

function toIssues(error: ZodError, location: ValidationTarget): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [location, ...issue.path.map(String)].join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function clientKey(request: FastifyRequest): string {
  return validationFailureKey(request.ip || 'unknown', request.routeOptions?.url || request.url);
}

/**
 * Builds a Fastify preHandler that validates and sanitizes the requested
 * locations. Throws a `RequestValidationError` (400) on failure and records the
 * failure for repeated-offender rate limiting.
 */
export function validateRequest(schemas: RequestValidationSchemas) {
  return async function validationPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const key = clientKey(request);
    assertNotBlockedByFailures(key);

    const targets: ValidationTarget[] = ['body', 'query', 'params'];

    for (const target of targets) {
      const schema = schemas[target];
      if (!schema) continue;

      const raw = request[target];
      const candidate = target === 'body' ? sanitizeValue(raw) : raw;

      const result = compileSchema(schema).safeParse(candidate);
      if (!result.success) {
        const issues = toIssues(result.error, target);
        recordValidationFailure(key);

        logger.warn(
          {
            method: request.method,
            url: request.url,
            target,
            ip: request.ip,
            issues: issues.map((issue) => ({ path: issue.path, code: issue.code })),
            suspicious: detectSuspiciousInput(raw),
          },
          'Request validation failed'
        );

        throw new RequestValidationError(issues);
      }

      // Write the parsed (and sanitized) value back onto the request.
      (request as unknown as Record<string, unknown>)[target] = result.data;
    }
  };
}

/**
 * Convenience wrapper that validates only the request body.
 */
export function validateBody(schema: ZodSchema) {
  return validateRequest({ body: schema });
}

/**
 * Backwards compatible alias kept for existing call sites.
 */
export const createValidationMiddleware = (schema: ZodSchema) => validateBody(schema);
