import { beforeEach, describe, expect, it, vi } from 'vitest';

const { del, delPattern } = vi.hoisted(() => ({
  del: vi.fn().mockResolvedValue(undefined),
  delPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../index', () => ({
  default: { del, delPattern },
  CacheType: {},
}));

import {
  CACHE_TTLS_MS,
  creatorCacheKeys,
  invalidateCaches,
  tipCacheKeys,
  userCacheKeys,
} from '../invalidation';

describe('cache invalidation helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses short cache TTLs for frequently read data', () => {
    expect(CACHE_TTLS_MS.tips).toBe(5_000);
    expect(CACHE_TTLS_MS.creators).toBe(60_000);
    expect(CACHE_TTLS_MS.users).toBe(30_000);
  });

  it('builds invalidation keys for tip lists and user history', () => {
    expect(tipCacheKeys('tip-1', 'creator-1', 'user-1')).toEqual(
      expect.arrayContaining([
        'v1:tips:creator-list:creator-1:*',
        'v1:tips:creator-cursor:creator-1:*',
        'v1:tips:search:*',
        'v1:tips:user-history:user-1:*',
        'v1:user:stats:transaction-history:user-1:*',
      ])
    );
  });

  it('invalidates creator aliases and user profile/stat keys', () => {
    expect(creatorCacheKeys('creator-1', 'creator-name', 'user-1')).toEqual([
      'v1:creator:creator-1',
      'v1:creator:userId:user-1',
      'v1:creator:username:creator-name',
    ]);
    expect(userCacheKeys('user-1')).toEqual([
      'v1:user:user-1',
      'v1:user:user-1:settings',
    ]);
  });

  it('deletes exact and pattern keys without publishing duplicate events', async () => {
    await invalidateCaches(['v1:user:user-1', 'v1:tips:list:*', 'v1:user:user-1'], 'manual', {
      publish: false,
    });

    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith('v1:user:user-1');
    expect(delPattern).toHaveBeenCalledOnce();
    expect(delPattern).toHaveBeenCalledWith('v1:tips:list:*');
  });
});