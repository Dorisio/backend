import { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCodes, ERROR_CATALOG, getErrorDefinition, isAppError } from '../utils/errors';
import { ApiErrorResponse, formatError } from '../types/response';
import { logger } from '../utils/logger';
import { captureError } from '../lib/error-tracking';
import { DEFAULT_LOCALE, ErrorLocale, getCatalog, resolveLocale, translateError } from '../i18n/errors';

export interface NormalizedError {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  expose: boolean;
  operational: boolean;
  logLevel: 'warn' | 'error';
  cause?: unknown;
}

interface FastifyLikeError extends Error {
  statusCode?: number;
  code?: string;
  validation?: unknown[];
}

/** Prisma known-request error codes mapped to API errors. */
const PRISMA_ERROR_MAP: Record<string, { statusCode: number; code: string; message: string }> = {
  P2000: { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'Value too long for the field' },
  P2002: { statusCode: 409, code: ErrorCodes.CONFLICT, message: 'A resource with these values already exists' },
  P2003: { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'Related resource does not exist' },
  P2011: { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'A required field cannot be null' },
  P2012: { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'A required field is missing' },
  P2014: { statusCode: 400, code: ErrorCodes.VALIDATION_ERROR, message: 'The change violates a required relation' },
  P2025: { statusCode: 404, code: ErrorCodes.NOT_FOUND, message: 'The requested record was not found' },
  P1001: { statusCode: 503, code: ErrorCodes.DATABASE_UNAVAILABLE, message: 'Cannot reach the database' },
  P1002: { statusCode: 503, code: ErrorCodes.DATABASE_UNAVAILABLE, message: 'The database timed out' },
  P1008: { statusCode: 503, code: ErrorCodes.DATABASE_UNAVAILABLE, message: 'The database operation timed out' },
  P1017: { statusCode: 503, code: ErrorCodes.DATABASE_UNAVAILABLE, message: 'The database connection was closed' },
};

function isPrismaError(error: unknown): error is { name?: string; code?: string; meta?: unknown } {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; code?: string };
  if (typeof candidate.name === 'string' && candidate.name.startsWith('PrismaClient')) {
    return true;
  }
  return typeof candidate.code === 'string' && /^P\d{4}$/.test(candidate.code);
}

function isJwtError(error: unknown): error is { name: string; message: string } {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'JsonWebTokenError' || name === 'TokenExpiredError' || name === 'NotBeforeError';
}

function normalizeZodError(error: ZodError): NormalizedError {
  return {
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: ERROR_CATALOG[ErrorCodes.VALIDATION_ERROR].message,
    details: {
      // Only safe, client-actionable information is included.
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    },
    expose: true,
    operational: true,
    logLevel: 'warn',
    cause: error,
  };
}

function normalizeFastifyValidation(error: FastifyLikeError): NormalizedError {
  const issues = Array.isArray(error.validation)
    ? error.validation.map((entry) => {
        const item = entry as { instancePath?: string; message?: string; keyword?: string };
        return {
          path: item.instancePath || '',
          message: item.message || 'Invalid value',
          code: item.keyword || 'invalid',
        };
      })
    : undefined;

  return {
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: ERROR_CATALOG[ErrorCodes.VALIDATION_ERROR].message,
    details: issues ? { issues } : undefined,
    expose: true,
    operational: true,
    logLevel: 'warn',
    cause: error,
  };
}

function normalizePrismaError(error: { name?: string; code?: string }): NormalizedError {
  if (error.name === 'PrismaClientValidationError') {
    return {
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'The request data is invalid',
      expose: true,
      operational: true,
      logLevel: 'warn',
      cause: error,
    };
  }

  if (error.name === 'PrismaClientInitializationError') {
    return {
      statusCode: 503,
      code: ErrorCodes.DATABASE_UNAVAILABLE,
      message: ERROR_CATALOG[ErrorCodes.DATABASE_UNAVAILABLE].message,
      expose: true,
      operational: false,
      logLevel: 'error',
      cause: error,
    };
  }

  const mapped = error.code ? PRISMA_ERROR_MAP[error.code] : undefined;
  if (mapped) {
    return {
      statusCode: mapped.statusCode,
      code: mapped.code,
      message: mapped.message,
      expose: true,
      operational: mapped.statusCode < 500,
      logLevel: mapped.statusCode >= 500 ? 'error' : 'warn',
      cause: error,
    };
  }

  // Unmapped database failure: never leak the driver message to the client.
  return {
    statusCode: 500,
    code: ErrorCodes.DATABASE_ERROR,
    message: ERROR_CATALOG[ErrorCodes.DATABASE_ERROR].message,
    expose: false,
    operational: false,
    logLevel: 'error',
    cause: error,
  };
}

/**
 * Converts any thrown value into a normalized, safe-to-serialize error.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      expose: error.expose,
      operational: error.isOperational,
      logLevel: error.statusCode >= 500 ? 'error' : 'warn',
      cause: error.cause ?? error,
    };
  }

  if (error instanceof ZodError) {
    return normalizeZodError(error);
  }

  if (isPrismaError(error)) {
    return normalizePrismaError(error);
  }

  if (isJwtError(error)) {
    const expired = (error as { name: string }).name === 'TokenExpiredError';
    return {
      statusCode: 401,
      code: expired ? 'TOKEN_EXPIRED' : ErrorCodes.UNAUTHORIZED,
      message: expired ? 'Your session has expired' : 'Invalid authentication token',
      expose: true,
      operational: true,
      logLevel: 'warn',
      cause: error,
    };
  }

  if (error && typeof error === 'object') {
    const candidate = error as FastifyLikeError;

    if (Array.isArray(candidate.validation)) {
      return normalizeFastifyValidation(candidate);
    }

    if (typeof candidate.statusCode === 'number') {
      const statusCode = candidate.statusCode;
      const expose = statusCode < 500;
      return {
        statusCode,
        code: candidate.code || getErrorDefinition(ErrorCodes.INTERNAL_ERROR).code,
        message: expose ? candidate.message : ERROR_CATALOG[ErrorCodes.INTERNAL_ERROR].message,
        expose,
        operational: expose,
        logLevel: statusCode >= 500 ? 'error' : 'warn',
        cause: error,
      };
    }

    if (candidate.name === 'SyntaxError' || candidate.name === 'FastifyError') {
      return {
        statusCode: candidate.statusCode ?? 400,
        code: candidate.code ?? ErrorCodes.BAD_REQUEST,
        message: 'Malformed request body',
        expose: true,
        operational: true,
        logLevel: 'warn',
        cause: error,
      };
    }
  }

  // Unknown / unexpected failure: never expose the internal message.
  return {
    statusCode: 500,
    code: ErrorCodes.INTERNAL_ERROR,
    message: ERROR_CATALOG[ErrorCodes.INTERNAL_ERROR].message,
    expose: false,
    operational: false,
    logLevel: 'error',
    cause: error,
  };
}

/**
 * Localizes generic framework messages while preserving domain specific ones.
 * A message is only translated when it matches the canonical English wording.
 */
export function localizeMessage(message: string, code: string, locale: ErrorLocale): string {
  if (locale === DEFAULT_LOCALE) {
    return message;
  }

  const canonical = getCatalog(DEFAULT_LOCALE)[code] ?? ERROR_CATALOG[code]?.message;
  if (canonical !== message) {
    return message;
  }

  return translateError(code, locale, message) ?? message;
}

export interface ErrorResponseOptions {
  locale?: ErrorLocale;
  requestId?: string;
}

/**
 * Builds the standardized error body. Stack traces and raw exception messages
 * for non-operational errors are stripped here.
 */
export function buildErrorResponse(
  normalized: NormalizedError,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const message = normalized.expose
    ? localizeMessage(normalized.message, normalized.code, locale)
    : getErrorDefinition(normalized.code).message;

  const details = normalized.expose ? normalized.details : undefined;

  return formatError(message, normalized.code, details);
}

function getRequestLocale(request: FastifyRequest): ErrorLocale {
  const header = request.headers['accept-language'];
  return resolveLocale(header);
}

/**
 * Fastify global error handler. Registered once for the whole app so every
 * route gets consistent, sanitized errors without repeating try/catch blocks.
 */
export async function globalErrorHandler(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const normalized = normalizeError(error);
  const locale = getRequestLocale(request);
  const body = buildErrorResponse(normalized, { locale });

  const logPayload = {
    err: normalized.cause ?? error,
    code: normalized.code,
    statusCode: normalized.statusCode,
    method: request.method,
    url: request.url,
    requestId: request.id,
    userId: request.user?.userId,
  };

  if (normalized.logLevel === 'error') {
    logger.error(logPayload, 'Request failed');
  } else {
    logger.warn(logPayload, 'Request rejected');
  }

  captureError(normalized.cause ?? error, {
    requestId: request.id,
    method: request.method,
    url: request.url,
    userId: request.user?.userId,
    code: normalized.code,
    operational: normalized.operational,
    statusCode: normalized.statusCode,
  });

  if (!reply.sent) {
    reply.code(normalized.statusCode).send(body);
  }
}

/**
 * Standardized 404 for routes that do not exist.
 */
export async function notFoundHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const locale = getRequestLocale(request);
  const normalized: NormalizedError = {
    statusCode: 404,
    code: ErrorCodes.NOT_FOUND,
    message: `Route ${request.method} ${request.url} not found`,
    expose: true,
    operational: true,
    logLevel: 'warn',
  };

  logger.warn(
    { method: request.method, url: request.url, requestId: request.id },
    'Route not found'
  );

  reply.code(404).send(buildErrorResponse(normalized, { locale }));
}
