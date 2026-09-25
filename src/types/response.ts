export interface ApiErrorPayload {
  /** Stable machine readable error code clients can branch on. */
  code: string;
  /** Human readable, sanitized message. Never contains internal details. */
  message: string;
  /** Optional structured context (e.g. field level validation issues). */
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorPayload;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
  timestamp: string;
}

export const formatSuccess = <T>(data: T): ApiResponse<T> => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

export const formatError = (
  message: string,
  code: string,
  details?: Record<string, unknown>
): ApiErrorResponse => ({
  success: false,
  error: {
    code,
    message,
    ...(details ? { details } : {}),
  },
  timestamp: new Date().toISOString(),
});
