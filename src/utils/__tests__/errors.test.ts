import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  DatabaseError,
  ErrorCodes,
  ExternalServiceError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  getErrorDefinition,
  isAppError,
} from '../errors';

describe('error taxonomy', () => {
  it('exposes a stable code and status for each concrete error', () => {
    expect(new ValidationError('bad')).toMatchObject({
      statusCode: 400,
      code: ErrorCodes.VALIDATION_ERROR,
    });
    expect(new UnauthorizedError()).toMatchObject({
      statusCode: 401,
      code: ErrorCodes.UNAUTHORIZED,
    });
    expect(new ForbiddenError()).toMatchObject({
      statusCode: 403,
      code: ErrorCodes.FORBIDDEN,
    });
    expect(new NotFoundError('Tip')).toMatchObject({
      statusCode: 404,
      code: ErrorCodes.NOT_FOUND,
      message: 'Tip not found',
    });
    expect(new ConflictError()).toMatchObject({ statusCode: 409, code: ErrorCodes.CONFLICT });
    expect(new TooManyRequestsError()).toMatchObject({
      statusCode: 429,
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
    });
    expect(new InternalServerError()).toMatchObject({
      statusCode: 500,
      code: ErrorCodes.INTERNAL_ERROR,
    });
    expect(new DatabaseError()).toMatchObject({ statusCode: 500, code: ErrorCodes.DATABASE_ERROR });
    expect(new ExternalServiceError()).toMatchObject({
      statusCode: 502,
      code: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    });
    expect(new ServiceUnavailableError()).toMatchObject({
      statusCode: 503,
      code: ErrorCodes.SERVICE_UNAVAILABLE,
    });
    expect(new BadRequestError()).toMatchObject({ statusCode: 400, code: ErrorCodes.BAD_REQUEST });
  });

  it('carries structured details for client-side handling', () => {
    const error = new ValidationError('invalid', { field: 'amount' });
    expect(error.details).toEqual({ field: 'amount' });
  });

  it('marks 5xx errors as non-operational and non-exposing by default', () => {
    const error = new InternalServerError('database exploded');
    expect(error.isOperational).toBe(false);
    expect(error.expose).toBe(false);
    expect(error.statusCode).toBe(500);
  });

  it('keeps operational 4xx errors exposed', () => {
    const error = new NotFoundError('Creator');
    expect(error.isOperational).toBe(true);
    expect(error.expose).toBe(true);
  });

  it('supports error chaining via cause', () => {
    const cause = new Error('root cause');
    const error = new DatabaseError('wrapper', { cause });
    expect(error.cause).toBe(cause);
  });

  it('is an Error subclass with a working prototype chain', () => {
    const error = new ValidationError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.name).toBe('ValidationError');
    expect(error.stack).toBeDefined();
  });

  it('identifies AppError instances and rejects plain errors', () => {
    expect(isAppError(new ValidationError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('returns catalog defaults and a safe fallback for unknown codes', () => {
    expect(getErrorDefinition(ErrorCodes.NOT_FOUND)).toMatchObject({
      statusCode: 404,
      expose: true,
    });

    const unknown = getErrorDefinition('SOMETHING_WEIRD');
    expect(unknown.statusCode).toBe(500);
    expect(unknown.expose).toBe(false);
    expect(unknown.code).toBe('SOMETHING_WEIRD');
  });
});
