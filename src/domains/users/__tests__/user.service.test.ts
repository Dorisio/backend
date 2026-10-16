/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheStore, invalidateCaches } = vi.hoisted(() => {
  const cacheStore = new Map<string, unknown>();
  return {
    cacheStore,
    invalidateCaches: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        if (key.endsWith('*')) {
          const prefix = key.slice(0, -1);
          for (const cachedKey of cacheStore.keys()) {
            if (cachedKey.startsWith(prefix)) cacheStore.delete(cachedKey);
          }
        } else {
          cacheStore.delete(key);
        }
      }
    }),
  };
});

vi.mock('../../../lib/cache/cache-aside', () => ({
  CacheType: { USER: 'user' },
  createCacheKey: (type: string, id: string) => `${type}:${id}`,
  getOrFetch: async ({ key, fetchFn }: { key: string; fetchFn: () => Promise<unknown> }) => {
    if (cacheStore.has(key)) return cacheStore.get(key);
    const value = await fetchFn();
    cacheStore.set(key, value);
    return value;
  },
  update: async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  },
}));

vi.mock('../../../lib/cache/invalidation', () => ({
  CACHE_TTLS_MS: { users: 30_000 },
  invalidateCaches,
  userCacheKeys: (userId: string) => [
    `user:${userId}`,
    `user:${userId}:settings`,
    `user:stats:transaction-history:${userId}:*`,
  ],
}));

vi.mock('../../../utils/token-blacklist', () => ({
  blacklistToken: vi.fn(async () => undefined),
}));

import { UserService } from '../user.service';
import { AVATAR_MAX_BYTES, decodeAvatarDataUrl } from '../avatar.storage';
import { hashPassword } from '../../../utils/password';
import { ValidationError } from '../../../utils/errors';
import { blacklistToken } from '../../../utils/token-blacklist';

/** Minimal in-memory Prisma stand-in covering the models UserService touches. */
class FakePrisma {
  users: any[] = [];
  changes: any[] = [];
  tips: any[] = [];
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value);
  }

  user = {
    findUnique: async ({ where }: any) =>
      this.users.find((candidate) => this.matches(candidate, where)) ?? null,
    update: async ({ where, data }: any) => {
      const user = this.users.find((candidate) => candidate.id === where.id);
      if (!user) throw new Error('User not found');
      Object.assign(user, data, { updatedAt: new Date() });
      return user;
    },
  };

  profileChange = {
    createMany: async ({ data }: any) => {
      for (const entry of data) {
        this.changes.push({ ...entry, id: this.nextId('chg'), createdAt: new Date() });
      }
      return { count: data.length };
    },
    findMany: async ({ where, skip = 0, take = 20 }: any) =>
      this.changes
        .filter((row) => this.matches(row, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(skip, skip + take),
    count: async ({ where }: any) => this.changes.filter((row) => this.matches(row, where)).length,
  };

  tip = {
    findMany: vi.fn(async ({ where, skip = 0, take = 20 }: any) =>
      this.tips.filter((tip) => tip.fromUserId === where.fromUserId).slice(skip, skip + take)
    ),
    count: vi.fn(async ({ where }: any) =>
      this.tips.filter((tip) => tip.fromUserId === where.fromUserId).length
    ),
  };
}

const seedUser = (prisma: FakePrisma, overrides: Record<string, unknown> = {}) => {
  const user = {
    id: 'u1',
    email: 'user@example.com',
    name: 'Old Name',
    bio: null,
    avatar: null,
    password: 'hashed',
    role: 'fan',
    verified: false,
    notificationPreferences: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  prisma.users.push(user);
  return user;
};

describe('UserService profile management (#49)', () => {
  let prisma: FakePrisma;
  let service: UserService;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    prisma = new FakePrisma();
    seedUser(prisma);
    service = new UserService(prisma as any);
  });

  it('applies partial name/bio updates and records a non-sensitive audit row per field', async () => {
    const result = await service.updateUserProfile(
      'u1',
      { name: 'New Name', bio: 'Building on Stellar' },
      { ip: '1.2.3.4', userAgent: 'vitest' }
    );

    expect(result.name).toBe('New Name');
    expect(result.bio).toBe('Building on Stellar');
    expect(prisma.users[0].name).toBe('New Name');

    expect(prisma.changes).toHaveLength(2);
    const fields = prisma.changes.map((change) => change.field).sort();
    expect(fields).toEqual(['bio', 'name']);
    expect(prisma.changes.every((change) => change.sensitive === false)).toBe(true);
    expect(prisma.changes[0].ip).toBe('1.2.3.4');
  });

  it('only audits fields whose value actually changed', async () => {
    await service.updateUserProfile('u1', { name: 'Old Name' });
    expect(prisma.changes).toHaveLength(0);
  });

  it('caches user transaction history and invalidates it after profile changes', async () => {
    prisma.tips.push({
      id: 'tip-1',
      fromUserId: 'u1',
      amount: 10,
      status: 'completed',
      creatorId: 'creator-1',
      message: 'first',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      creator: { displayName: 'Creator' },
    });

    const first = await service.getUserTransactionHistory('u1');
    prisma.tips.push({
      id: 'tip-2',
      fromUserId: 'u1',
      amount: 20,
      status: 'pending',
      creatorId: 'creator-1',
      message: 'second',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      creator: { displayName: 'Creator' },
    });

    const cached = await service.getUserTransactionHistory('u1');
    expect(cached).toEqual(first);
    expect(prisma.tip.findMany).toHaveBeenCalledOnce();

    await service.updateUserProfile('u1', { name: 'Updated Name' });
    expect(invalidateCaches).toHaveBeenCalledWith(
      expect.arrayContaining(['user:u1', 'user:u1:settings', 'user:stats:transaction-history:u1:*']),
      'user.updated'
    );

    const refreshed = await service.getUserTransactionHistory('u1');
    expect(refreshed.total).toBe(2);
    expect(prisma.tip.findMany).toHaveBeenCalledTimes(2);
  });

  it('refuses email changes through the profile endpoint', async () => {
    await expect(
      service.updateUserProfile('u1', { email: 'attacker@example.com' } as never)
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.users[0].email).toBe('user@example.com');
  });

  it('requires the current password to change the password', async () => {
    prisma.users[0].password = await hashPassword('correct-horse');

    await expect(
      service.changePassword('u1', {
        currentPassword: 'wrong-password',
        newPassword: 'brand-new-password',
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rotates the password, audits it as sensitive and revokes the caller token', async () => {
    prisma.users[0].password = await hashPassword('correct-horse');

    const result = await service.changePassword(
      'u1',
      { currentPassword: 'correct-horse', newPassword: 'brand-new-password' },
      { ip: '9.9.9.9' },
      'access-token-123'
    );

    expect(result.success).toBe(true);
    expect(prisma.users[0].password).not.toBe('correct-horse');
    expect(prisma.users[0].password).not.toBe('brand-new-password');

    const passwordChange = prisma.changes.find((change) => change.field === 'password');
    expect(passwordChange).toBeDefined();
    expect(passwordChange.sensitive).toBe(true);
    expect(passwordChange.oldValue).toBeNull();
    expect(passwordChange.newValue).toBeNull();

    expect(vi.mocked(blacklistToken)).toHaveBeenCalledWith('access-token-123', expect.any(Date));
  });

  it('persists settings to notificationPreferences and audits the delta', async () => {
    const result = await service.updateUserSettings('u1', { emailDigest: 'daily' }, {});

    expect(result.emailDigest).toBe('daily');
    expect(result.notificationsEnabled).toBe(true);
    expect(prisma.users[0].notificationPreferences).toEqual({
      notificationsEnabled: true,
      emailDigest: 'daily',
    });
    expect(prisma.changes).toHaveLength(1);
    expect(prisma.changes[0].field).toBe('emailDigest');
  });

  it('rejects a non-image avatar payload', () => {
    expect(() => decodeAvatarDataUrl('https://example.com/me.png')).toThrow(ValidationError);
    expect(() => decodeAvatarDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toThrow(
      ValidationError
    );
  });

  it('rejects an avatar larger than 5MB', () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(AVATAR_MAX_BYTES + 1, 1).toString(
      'base64'
    )}`;
    expect(() => decodeAvatarDataUrl(oversized)).toThrow(/5MB/);
  });

  it('decodes a valid PNG data URL', () => {
    const png = `data:image/png;base64,${Buffer.from('tiny-png-bytes').toString('base64')}`;
    const decoded = decodeAvatarDataUrl(png);
    expect(decoded.extension).toBe('png');
    expect(decoded.bytes.toString('utf8')).toBe('tiny-png-bytes');
  });
});
