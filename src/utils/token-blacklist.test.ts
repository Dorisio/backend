import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredTokens,
  closeTokenBlacklist,
  initTokenBlacklist,
  isUserAuthVersionCurrent,
} from './token-blacklist';

const mockPrisma = {
  blacklistedToken: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  passwordResetToken: {
    deleteMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
};

describe('password-reset session invalidation and cleanup', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.blacklistedToken.findMany.mockResolvedValue([]);
    mockPrisma.blacklistedToken.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 });
    await initTokenBlacklist(mockPrisma as never);
  });

  afterEach(() => closeTokenBlacklist());

  it('accepts JWTs at the current version and rejects versions invalidated by a reset', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ authVersion: 4 });

    await expect(isUserAuthVersionCurrent('user-1', 4)).resolves.toBe(true);
    await expect(isUserAuthVersionCurrent('user-1', 3)).resolves.toBe(false);
  });

  it('periodically deletes expired password reset tokens', async () => {
    await cleanupExpiredTokens();

    expect(mockPrisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });
});
