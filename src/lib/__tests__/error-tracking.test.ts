import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  captureError,
  configureErrorTracking,
  getErrorStats,
  getRecentErrors,
  parseSentryDsn,
  resetErrorTracking,
  sentryTransport,
} from '../error-tracking';

const DSN = 'https://public-key@sentry.example.com/42';

describe('error tracking', () => {
  beforeEach(() => {
    resetErrorTracking();
  });

  it('records captured errors with sanitized metadata', () => {
    const tracked = captureError(new Error('kaboom'), {
      requestId: 'req-1',
      method: 'GET',
      url: '/x',
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      operational: false,
    });

    expect(tracked.code).toBe('INTERNAL_ERROR');
    expect(tracked.message).toBe('kaboom');
    expect(tracked.statusCode).toBe(500);
    expect(tracked.context.requestId).toBe('req-1');
    expect(getRecentErrors()).toHaveLength(1);
    expect(getErrorStats().total).toBe(1);
    expect(getErrorStats().byCode.INTERNAL_ERROR).toBe(1);
  });

  it('defaults to INTERNAL_ERROR/500 when no context is supplied', () => {
    const tracked = captureError('boom');
    expect(tracked.code).toBe('INTERNAL_ERROR');
    expect(tracked.statusCode).toBe(500);
    expect(tracked.message).toContain('boom');
  });

  it('bounds the recent error buffer', () => {
    configureErrorTracking({ enabled: false, bufferSize: 2 });
    captureError(new Error('one'));
    captureError(new Error('two'));
    captureError(new Error('three'));

    const recent = getRecentErrors();
    expect(recent).toHaveLength(2);
    expect(recent[0].message).toBe('two');
    expect(getErrorStats().total).toBe(3);
  });

  it('forwards errors to the configured transport when enabled', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    configureErrorTracking({ enabled: true, dsn: DSN, sampleRate: 1, transport });

    captureError(new Error('report me'), { code: 'DATABASE_ERROR', statusCode: 500 });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const [tracked, dsn] = transport.mock.calls[0];
    expect(tracked.message).toBe('report me');
    expect(dsn).toBe(DSN);
  });

  it('does not forward when disabled', () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    configureErrorTracking({ enabled: false, dsn: DSN, sampleRate: 1, transport });

    captureError(new Error('quiet'));

    expect(transport).not.toHaveBeenCalled();
  });

  it('does not forward when no DSN is configured', () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    configureErrorTracking({ enabled: true, dsn: undefined, sampleRate: 1, transport });

    captureError(new Error('no dsn'));

    expect(transport).not.toHaveBeenCalled();
  });

  it('respects the sample rate', () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    configureErrorTracking({ enabled: true, dsn: DSN, sampleRate: 0, transport });

    captureError(new Error('sampled out'));

    expect(transport).not.toHaveBeenCalled();
  });

  it('parses valid Sentry DSNs and rejects malformed ones', () => {
    expect(parseSentryDsn(DSN)).toEqual({
      protocol: 'https',
      host: 'sentry.example.com',
      projectId: '42',
      publicKey: 'public-key',
    });
    expect(parseSentryDsn('not-a-url')).toBeNull();
    expect(parseSentryDsn('https://sentry.example.com/42')).toBeNull();
  });

  it('never throws when the transport fails', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('network down'));
    configureErrorTracking({ enabled: true, dsn: DSN, sampleRate: 1, transport });

    expect(() => captureError(new Error('still safe'))).not.toThrow();
    await vi.waitFor(() => expect(transport).toHaveBeenCalled());
  });

  it('exposes a Sentry transport function', () => {
    expect(typeof sentryTransport).toBe('function');
  });
});
