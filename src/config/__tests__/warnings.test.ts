import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { collectConfigWarnings, logConfigWarnings } from '../warnings';

const safe = { TRUST_PROXY: '1', RATE_LIMIT_ENABLED: true };

function captureLogger(level: string) {
  const lines: Record<string, unknown>[] = [];
  const log = pino(
    { level },
    { write: (line: string) => lines.push(JSON.parse(line)) }
  );
  return { log, lines };
}

describe('collectConfigWarnings', () => {
  it('reports nothing for a safe configuration', () => {
    expect(collectConfigWarnings(safe)).toEqual([]);
    expect(collectConfigWarnings({ ...safe, TRUST_PROXY: '10.0.0.0/8' })).toEqual([]);
  });

  it('flags TRUST_PROXY=true', () => {
    expect(collectConfigWarnings({ ...safe, TRUST_PROXY: 'true' })).toEqual([
      expect.objectContaining({ setting: 'TRUST_PROXY' }),
    ]);
  });

  it('flags disabled rate limiting', () => {
    expect(collectConfigWarnings({ ...safe, RATE_LIMIT_ENABLED: false })).toEqual([
      expect.objectContaining({ setting: 'RATE_LIMIT_ENABLED' }),
    ]);
  });
});

describe('logConfigWarnings', () => {
  const warnings = [{ setting: 'TRUST_PROXY', message: 'unsafe' }];

  it('logs structured warn entries plus a summary', () => {
    const { log, lines } = captureLogger('info');
    logConfigWarnings(log, warnings);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 40, configWarning: true, setting: 'TRUST_PROXY' });
    expect(lines[1]).toMatchObject({ level: 40, configWarning: true, count: 1, settings: ['TRUST_PROXY'] });
  });

  it.each([
    ['error', 50],
    ['fatal', 60],
  ])('is still emitted when LOG_LEVEL=%s', (level, numeric) => {
    const { log, lines } = captureLogger(level);
    logConfigWarnings(log, warnings);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: numeric, setting: 'TRUST_PROXY' });
  });

  it('logs nothing when there are no warnings', () => {
    const { log, lines } = captureLogger('info');
    const spy = vi.spyOn(log, 'warn');
    logConfigWarnings(log, []);
    expect(lines).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
