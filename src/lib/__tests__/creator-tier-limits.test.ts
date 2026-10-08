import { describe, it, expect } from 'vitest';
import {
  CreatorTierLimiter,
  DAY_MS,
  MINUTE_MS,
  buildTierQuotaHeaders,
  tiersAtLeast,
} from '../creator-tier-limits';

function clock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('CreatorTierLimiter', () => {
  it('spends the plan budget and reports what is left', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    const first = limiter.consume('creator_1', 'free');

    expect(first.allowed).toBe(true);
    expect(first.minute.limit).toBe(60);
    expect(first.minute.used).toBe(1);
    expect(first.minute.remaining).toBe(59);
    expect(first.day.limit).toBe(5000);
    expect(first.day.used).toBe(1);
  });

  it('applies a larger budget to a paid tier', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    limiter.consume('creator_1', 'free', 60);
    // The same creator, now paying: the upgraded budget applies immediately.
    const upgrade = limiter.consume('creator_1', 'pro', 1);

    expect(upgrade.allowed).toBe(true);
    expect(upgrade.minute.limit).toBe(300);
    expect(upgrade.minute.used).toBe(61);
  });

  it('rejects the request that exceeds the minute window without consuming quota', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    limiter.consume('creator_1', 'free', 60);
    const blocked = limiter.consume('creator_1', 'free');

    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('minute');
    expect(blocked.retryAfterSeconds).toBe(60);
    // A throttled client cannot extend its own lockout.
    expect(limiter.peek('creator_1', 'free').minute.used).toBe(60);
  });

  it('rolls the minute window over while the day window keeps counting', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    limiter.consume('creator_1', 'free', 60);
    time.advance(MINUTE_MS + 1);

    const afterMinute = limiter.consume('creator_1', 'free');
    expect(afterMinute.allowed).toBe(true);
    expect(afterMinute.minute.used).toBe(1);
    expect(afterMinute.day.used).toBe(61);

    const blocked = limiter.consume('creator_1', 'free', 5000);
    expect(blocked.allowed).toBe(true);

    time.advance(DAY_MS + 1);
    const afterDay = limiter.consume('creator_1', 'free');
    expect(afterDay.day.used).toBe(1);
  });

  it('keys quota per creator so one creator cannot spend another budget', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    limiter.consume('creator_1', 'free', 60);

    expect(limiter.consume('creator_1', 'free').allowed).toBe(false);
    expect(limiter.consume('creator_2', 'free').allowed).toBe(true);
  });

  it('reports the day window when the day budget is the one exhausted', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    // Spend the daily budget across many minutes, so the minute window is never
    // the one that trips first.
    for (let minute = 0; minute < 84; minute += 1) {
      limiter.consume('creator_1', 'free', 60);
      time.advance(MINUTE_MS + 1);
    }

    const blocked = limiter.peek('creator_1', 'free');

    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('day');
    expect(blocked.day.used).toBe(5_040);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('prunes expired windows and can be reset', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });

    limiter.consume('creator_1', 'free');
    expect(limiter.size()).toBe(2);

    time.advance(DAY_MS + 1);
    expect(limiter.prune()).toBe(2);
    expect(limiter.size()).toBe(0);

    limiter.consume('creator_1', 'free');
    limiter.reset('creator_1');
    expect(limiter.size()).toBe(0);
  });

  it('bounds tracked creators so memory cannot grow without limit', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now, maxKeys: 4 });

    for (let i = 0; i < 10; i += 1) {
      limiter.consume(`creator_${i}`, 'free');
    }

    expect(limiter.size()).toBeLessThanOrEqual(4);
  });
});

describe('buildTierQuotaHeaders', () => {
  it('exposes both windows and the retry hint when throttled', () => {
    const time = clock(Date.UTC(2026, 8, 27));
    const limiter = new CreatorTierLimiter({ now: time.now });
    limiter.consume('creator_1', 'free', 60);

    const headers = buildTierQuotaHeaders(limiter.peek('creator_1', 'free'), 'api_access');

    expect(headers['x-creator-tier']).toBe('free');
    expect(headers['x-creator-feature']).toBe('api_access');
    expect(headers['x-ratelimit-limit']).toBe('60');
    expect(headers['x-ratelimit-remaining']).toBe('0');
    expect(headers['x-ratelimit-scope']).toBe('minute');
    expect(headers['x-creator-tier-day-limit']).toBe('5000');
    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lists the tiers that unlock a minimum level', () => {
    expect(tiersAtLeast('pro')).toEqual(['pro', 'enterprise']);
    expect(tiersAtLeast('free')).toEqual(['free', 'pro', 'enterprise']);
  });
});
