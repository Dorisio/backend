import axios from 'axios';
import { Counter } from 'prom-client';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Lightweight, dependency-conscious error tracking.
 *
 * - Every captured error increments a Prometheus counter so error frequency and
 *   patterns are observable (and alertable) via `/metrics`.
 * - A bounded in-memory ring buffer keeps recent errors available for ad-hoc
 *   debugging and tests.
 * - When a Sentry compatible DSN is configured the error is also forwarded to
 *   Sentry's store API, best-effort and without blocking the request path.
 *
 * The transport is injectable so tests never talk to the network.
 */

export const errorsTotal = new Counter({
  name: 'dorisio_errors_total',
  help: 'Total number of errors handled by the API',
  labelNames: ['code', 'status', 'operational'],
});

export interface ErrorContext {
  requestId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  userId?: string;
  [key: string]: unknown;
}

export interface TrackedError {
  id: string;
  code: string;
  message: string;
  statusCode: number;
  operational: boolean;
  timestamp: string;
  context: ErrorContext;
  stack?: string;
}

export interface ErrorStats {
  total: number;
  byCode: Record<string, number>;
  lastErrorAt: string | null;
}

export type ErrorTransport = (error: TrackedError, dsn: string) => Promise<void>;

export interface ErrorTrackingSettings {
  enabled: boolean;
  dsn?: string;
  sampleRate: number;
  bufferSize: number;
  transport: ErrorTransport;
}

const DEFAULT_BUFFER_SIZE = 100;

const buffer: TrackedError[] = [];
let byCode: Record<string, number> = {};
let totalCaptured = 0;
let lastErrorAt: string | null = null;

let settings: ErrorTrackingSettings | null = null;

function defaultSettings(): ErrorTrackingSettings {
  return {
    enabled: config.ERROR_TRACKING_ENABLED,
    dsn: config.SENTRY_DSN,
    sampleRate: config.ERROR_TRACKING_SAMPLE_RATE,
    bufferSize: DEFAULT_BUFFER_SIZE,
    transport: sentryTransport,
  };
}

function getSettings(): ErrorTrackingSettings {
  if (!settings) {
    settings = defaultSettings();
  }
  return settings;
}

/**
 * Overrides tracker configuration. Intended for tests and bootstrap code.
 */
export function configureErrorTracking(overrides: Partial<ErrorTrackingSettings>): void {
  settings = { ...getSettings(), ...overrides };
}

/** Restores configuration to the values derived from the environment. */
export function resetErrorTracking(): void {
  settings = null;
  buffer.length = 0;
  totalCaptured = 0;
  lastErrorAt = null;
  byCode = {};
}

interface ParsedDsn {
  protocol: string;
  host: string;
  projectId: string;
  publicKey: string;
}

export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, '').split('/')[0];
    if (!publicKey || !projectId) {
      return null;
    }
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.host,
      projectId,
      publicKey,
    };
  } catch {
    return null;
  }
}

/**
 * Sends an event to a Sentry compatible store endpoint. Never throws.
 */
export const sentryTransport: ErrorTransport = async (error, dsn) => {
  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    logger.warn('Invalid SENTRY_DSN configured, skipping error report');
    return;
  }

  const storeUrl = `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/store/`;
  const authHeader = [
    'Sentry sentry_version=7',
    `sentry_key=${parsed.publicKey}`,
    'sentry_client=dorisio-backend/0.1.0',
  ].join(', ');

  try {
    await axios.post(
      storeUrl,
      {
        event_id: error.id,
        timestamp: error.timestamp,
        level: error.operational ? 'warning' : 'error',
        logger: 'dorisio-backend',
        platform: 'node',
        message: error.message,
        tags: { code: error.code, status: String(error.statusCode) },
        extra: error.context,
        exception: error.stack
          ? { values: [{ type: error.code, value: error.message, stacktrace: { frames: [] } }] }
          : undefined,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': authHeader,
        },
        timeout: config.ERROR_TRACKING_TIMEOUT_MS,
      }
    );
  } catch (err) {
    logger.debug({ err }, 'Failed to forward error to Sentry');
  }
};

/**
 * Records an error and forwards it to the configured transport. Never throws:
 * error tracking must not affect the request outcome.
 */
export function captureError(error: unknown, context: ErrorContext = {}): TrackedError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const statusCode = typeof context.statusCode === 'number' ? context.statusCode : 500;
  const code = typeof context.code === 'string' ? context.code : 'INTERNAL_ERROR';
  const operational = context.operational === true;

  const tracked: TrackedError = {
    id: randomUUID(),
    code,
    message: normalized.message,
    statusCode,
    operational,
    timestamp: new Date().toISOString(),
    context,
    stack: normalized.stack,
  };

  totalCaptured += 1;
  byCode[code] = (byCode[code] ?? 0) + 1;
  lastErrorAt = tracked.timestamp;

  try {
    errorsTotal.inc({
      code,
      status: String(statusCode),
      operational: String(operational),
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to increment error metric');
  }

  const current = getSettings();

  buffer.push(tracked);
  while (buffer.length > current.bufferSize) {
    buffer.shift();
  }

  if (current.enabled && current.dsn && Math.random() < current.sampleRate) {
    void current.transport(tracked, current.dsn).catch((err) => {
      logger.debug({ err }, 'Error transport failed');
    });
  }

  return tracked;
}

export function getRecentErrors(limit = buffer.length): TrackedError[] {
  const count = Math.max(0, Math.min(limit, buffer.length));
  return buffer.slice(buffer.length - count);
}

export function getErrorStats(): ErrorStats {
  return {
    total: totalCaptured,
    byCode: { ...byCode },
    lastErrorAt,
  };
}
