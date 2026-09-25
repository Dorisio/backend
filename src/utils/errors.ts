/**
 * Canonical error taxonomy.
 *
 * Every error surfaced by the API is described by a stable machine readable
 * `code`, a human readable `message` and an HTTP `statusCode`. `details` is an
 * optional, serializable object that carries structured, non-sensitive context
 * (for example field level validation issues) so clients can react to a failure
 * programmatically.
 *
 * Error messages returned to clients are always sanitized: internal details and
 * stack traces never leave the server.
 */

export interface ErrorDetails {
  [key: string]: unknown;
}

/**
 * Stable error codes used across the API. Codes are part of the public contract
 * and should not change once released — clients branch on these values.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorDefinition {
  statusCode: number;
  code: string;
  message: string;
  /**
   * Whether `message` is safe to return to clients verbatim. Messages for
   * unexpected (non-operational) failures are never exposed.
   */
  expose: boolean;
}

/**
 * Fallback metadata for well known codes. Routes may still throw arbitrary
 * domain codes (e.g. `CREATOR_NOT_FOUND`); the registry is only used to fill in
 * sensible defaults when a definition is missing.
 */
export const ERROR_CATALOG: Record<string, ErrorDefinition> = {
  [ErrorCodes.VALIDATION_ERROR]: {
    statusCode: 400,
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'The request data is invalid',
    expose: true,
  },
  [ErrorCodes.BAD_REQUEST]: {
    statusCode: 400,
    code: ErrorCodes.BAD_REQUEST,
    message: 'Bad request',
    expose: true,
  },
  [ErrorCodes.UNAUTHORIZED]: {
    statusCode: 401,
    code: ErrorCodes.UNAUTHORIZED,
    message: 'Authentication is required',
    expose: true,
  },
  [ErrorCodes.FORBIDDEN]: {
    statusCode: 403,
    code: ErrorCodes.FORBIDDEN,
    message: 'You do not have permission to perform this action',
    expose: true,
  },
  [ErrorCodes.NOT_FOUND]: {
    statusCode: 404,
    code: ErrorCodes.NOT_FOUND,
    message: 'The requested resource was not found',
    expose: true,
  },
  [ErrorCodes.CONFLICT]: {
    statusCode: 409,
    code: ErrorCodes.CONFLICT,
    message: 'The request conflicts with the current state of the resource',
    expose: true,
  },
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: {
    statusCode: 429,
    code: ErrorCodes.RATE_LIMIT_EXCEEDED,
    message: 'Too many requests, please try again later',
    expose: true,
  },
  [ErrorCodes.PAYLOAD_TOO_LARGE]: {
    statusCode: 413,
    code: ErrorCodes.PAYLOAD_TOO_LARGE,
    message: 'The request payload is too large',
    expose: true,
  },
  [ErrorCodes.INTERNAL_ERROR]: {
    statusCode: 500,
    code: ErrorCodes.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
    expose: false,
  },
  [ErrorCodes.DATABASE_ERROR]: {
    statusCode: 500,
    code: ErrorCodes.DATABASE_ERROR,
    message: 'A database error occurred',
    expose: false,
  },
  [ErrorCodes.DATABASE_UNAVAILABLE]: {
    statusCode: 503,
    code: ErrorCodes.DATABASE_UNAVAILABLE,
    message: 'The service is temporarily unavailable',
    expose: true,
  },
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: {
    statusCode: 502,
    code: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    message: 'An upstream service failed to process the request',
    expose: true,
  },
  [ErrorCodes.SERVICE_UNAVAILABLE]: {
    statusCode: 503,
    code: ErrorCodes.SERVICE_UNAVAILABLE,
    message: 'The service is temporarily unavailable',
    expose: true,
  },
};

export function getErrorDefinition(code: string): ErrorDefinition {
  return (
    ERROR_CATALOG[code] ?? {
      statusCode: 500,
      code,
      message: ERROR_CATALOG[ErrorCodes.INTERNAL_ERROR].message,
      expose: false,
    }
  );
}

export interface AppErrorOptions {
  details?: ErrorDetails;
  /** Operational errors are expected (bad input, missing resource) and safe to expose. */
  isOperational?: boolean;
  /** Overrides the default exposure rule derived from the status code. */
  expose?: boolean;
  cause?: unknown;
}

/**
 * Base class for all errors that should be translated into a well defined HTTP
 * response by the global error handler.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: ErrorDetails;
  public readonly isOperational: boolean;
  public readonly expose: boolean;
  public readonly cause?: unknown;

  constructor(statusCode: number, code: string, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    // 4xx errors are, by definition, expected outcomes. 5xx errors only expose
    // their message when explicitly opted in.
    this.isOperational = options.isOperational ?? statusCode < 500;
    this.expose = options.expose ?? statusCode < 500;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
    // Preserve the prototype chain when compiled down (needed for instanceof).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: ErrorDetails) {
    super(400, ErrorCodes.BAD_REQUEST, message, { details });
    this.name = 'BadRequestError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request data is invalid', details?: ErrorDetails) {
    super(400, ErrorCodes.VALIDATION_ERROR, message, { details });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details?: ErrorDetails) {
    super(401, ErrorCodes.UNAUTHORIZED, message, { details });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: ErrorDetails) {
    super(403, ErrorCodes.FORBIDDEN, message, { details });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, details?: ErrorDetails) {
    super(404, ErrorCodes.NOT_FOUND, `${resource} not found`, { details });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: ErrorDetails) {
    super(409, ErrorCodes.CONFLICT, message, { details });
    this.name = 'ConflictError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', details?: ErrorDetails) {
    super(413, ErrorCodes.PAYLOAD_TOO_LARGE, message, { details });
    this.name = 'PayloadTooLargeError';
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', details?: ErrorDetails) {
    super(429, ErrorCodes.RATE_LIMIT_EXCEEDED, message, { details });
    this.name = 'TooManyRequestsError';
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'An unexpected error occurred', options: AppErrorOptions = {}) {
    super(500, ErrorCodes.INTERNAL_ERROR, message, { ...options, expose: options.expose ?? false });
    this.name = 'InternalServerError';
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'A database error occurred', options: AppErrorOptions = {}) {
    super(500, ErrorCodes.DATABASE_ERROR, message, { ...options, expose: options.expose ?? false });
    this.name = 'DatabaseError';
  }
}

export class ExternalServiceError extends AppError {
  constructor(message = 'An upstream service failed', details?: ErrorDetails) {
    super(502, ErrorCodes.EXTERNAL_SERVICE_ERROR, message, { details });
    this.name = 'ExternalServiceError';
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable', details?: ErrorDetails) {
    super(503, ErrorCodes.SERVICE_UNAVAILABLE, message, { details });
    this.name = 'ServiceUnavailableError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
