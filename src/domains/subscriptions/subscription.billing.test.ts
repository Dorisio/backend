import { describe, it, expect } from 'vitest';
import {
  addInterval,
  applyDiscount,
  monthBounds,
  monthlyEquivalent,
  prorate,
  retryDelayMs,
} from './subscription.billing';

const d = (s: string) => new Date(s);

describe('addInterval', () => {
  it('adds a day', () => {
    expect(addInterval(d('2026-01-31T00:00:00Z'), 'DAILY').toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });
  it('adds a week', () => {
    expect(addInterval(d('2026-01-01T00:00:00Z'), 'WEEKLY').toISOString()).toBe(
      '2026-01-08T00:00:00.000Z',
    );
  });
  it('adds a month', () => {
    expect(addInterval(d('2026-03-15T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2026-04-15T00:00:00.000Z',
    );
  });
  it('clamps Jan 31 to Feb 28', () => {
    expect(addInterval(d('2026-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
  it('clamps Jan 31 to Feb 29 in a leap year', () => {
    expect(addInterval(d('2028-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
  it('rolls over the year boundary', () => {
    expect(addInterval(d('2026-12-15T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });
  it('adds a year', () => {
    expect(addInterval(d('2026-05-10T00:00:00Z'), 'YEARLY').toISOString()).toBe(
      '2027-05-10T00:00:00.000Z',
    );
  });
  it('does not mutate the input date', () => {
    const input = d('2026-01-01T00:00:00Z');
    addInterval(input, 'DAILY');
    expect(input.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('prorate', () => {
  const start = d('2026-04-01T00:00:00Z');
  const end = d('2026-05-01T00:00:00Z');
  it('charges the full amount at the start of the period', () => {
    expect(prorate(30, start, end, start)).toBe(30);
  });
  it('charges half in the middle', () => {
    expect(prorate(30, start, end, d('2026-04-16T00:00:00Z'))).toBe(15);
  });
  it('charges nothing at the end', () => {
    expect(prorate(30, start, end, end)).toBe(0);
  });
  it('never charges more than the full amount when from is before the start', () => {
    expect(prorate(30, start, end, d('2026-03-01T00:00:00Z'))).toBe(30);
  });
  it('throws on an invalid period', () => {
    expect(() => prorate(10, end, start, start)).toThrow('Invalid period');
  });
});

describe('applyDiscount', () => {
  it('0% keeps the amount', () => expect(applyDiscount(10, 0)).toBe(10));
  it('50% halves it', () => expect(applyDiscount(10, 50)).toBe(5));
  it('100% is free', () => expect(applyDiscount(10, 100)).toBe(0));
  it('rejects negative', () => expect(() => applyDiscount(10, -1)).toThrow());
  it('rejects over 100', () => expect(() => applyDiscount(10, 101)).toThrow());
  it('rejects NaN', () => expect(() => applyDiscount(10, NaN)).toThrow());
});

describe('retryDelayMs', () => {
  it('follows the 1, 3, 5 day schedule', () => {
    expect(retryDelayMs(1)).toBe(86_400_000);
    expect(retryDelayMs(2)).toBe(3 * 86_400_000);
    expect(retryDelayMs(3)).toBe(5 * 86_400_000);
  });
  it('gives up after the last attempt', () => {
    expect(retryDelayMs(4)).toBeNull();
  });
});

describe('monthBounds / monthlyEquivalent', () => {
  it('returns the first of this and next month', () => {
    const { start, end } = monthBounds(d('2026-04-16T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
  it('normalises every interval to monthly', () => {
    expect(monthlyEquivalent(1, 'DAILY')).toBe(30);
    expect(monthlyEquivalent(12, 'YEARLY')).toBe(1);
    expect(monthlyEquivalent(10, 'MONTHLY')).toBe(10);
    expect(monthlyEquivalent(12, 'WEEKLY')).toBe(52);
  });
});