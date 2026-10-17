import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comparePasswords } from '../../utils/password';
import { TooManyRequestsError, UnauthorizedError, ValidationError } from '../../utils/errors';

const { enqueueEmailMock } = vi.hoisted(() => ({ enqueueEmailMock: vi.fn() }));
vi.mock('../../domains/notifications/email', () => ({ enqueueEmail: enqueueEmailMock }));

const { generateAccessTokenMock, generateRefreshTokenMock, verifyRefreshTokenMock } = vi.hoisted(() => ({
  generateAccessTokenMock: vi.fn(),
  generateRefreshTokenMock: vi.fn(),
  verifyRefreshTokenMock: vi.fn(),
}));
const { isRefreshTokenBlacklistedMock, blacklistRefreshTokenMock } = vi.hoisted(() => ({
  isRefreshTokenBlacklistedMock: vi.fn(),
  blacklistRefreshTokenMock: vi.fn(),
}));

vi.mock('../../utils/jwt', () => ({
  generateAccessToken: generateAccessTokenMock,
  generateRefreshToken: generateRefreshTokenMock,
  verifyRefreshToken: verifyRefreshTokenMock,
}));

vi.mock('../../utils/token-blacklist', () => ({
  isRefreshTokenBlacklisted: isRefreshTokenBlacklistedMock,
  blacklistRefreshToken: blacklistRefreshTokenMock,
}));

vi.mock('../../config', () => ({
  config: { JWT_REFRESH_EXPIRES_IN: '7d' },
}));

import { AuthService } from './auth.service';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { isRefreshTokenBlacklisted, blacklistRefreshToken } from '../../utils/token-blacklist';

const validUser = { id: 'user-1', email: 'person@example.com', name: 'Person' };
const resetRecord = {
  id: 'reset-1',
  email: validUser.email,
  token: 'stored-digest',
  userId: validUser.id,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  used: false,
};

const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  passwordResetToken: {
    count: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) => callback(mockPrisma)),
};

describe('AuthService password reset', () => {
  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AuthService(mockPrisma as never);
    mockPrisma.passwordResetToken.count.mockResolvedValue(0);
    mockPrisma.passwordResetToken.create.mockResolvedValue({ id: 'reset-1' });
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue(resetRecord);
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue(validUser);
    mockPrisma.user.findFirst.mockResolvedValue(validUser);
    mockPrisma.user.update.mockResolvedValue({ id: validUser.id });
    enqueueEmailMock.mockResolvedValue('job-1');
  });

  it('stores a one-hour token digest and queues a reset email', async () => {
    const before = Date.now();
    const result = await service.requestPasswordReset('Person@Example.com');

    expect(result.success).toBe(true);
    const stored = mockPrisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(stored.email).toBe(validUser.email);
    expect(stored.userId).toBe(validUser.id);
    expect(stored.token).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(enqueueEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: validUser.email,
      template: 'password-reset',
      data: expect.objectContaining({ link: expect.stringMatching(/reset-password\?token=[a-f0-9]{64}/) }),
    }));
    expect(enqueueEmailMock.mock.calls[0][0].data.link).not.toContain(stored.token);
  });

  it('returns a generic response and does not send email for an unknown account', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const result = await service.requestPasswordReset('unknown@example.com');

    expect(result.message).toContain('If an account exists');
    expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'unknown@example.com', userId: null }),
    });
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it('limits each email to three requests in a rolling hour', async () => {
    mockPrisma.passwordResetToken.count.mockResolvedValue(3);

    await expect(service.requestPasswordReset(validUser.email)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mockPrisma.passwordResetToken.count).toHaveBeenCalledWith({
      where: {
        email: validUser.email,
        createdAt: { gte: expect.any(Date) },
      },
    });
    expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(enqueueEmailMock).not.toHaveBeenCalled();
  });

  it('updates the password hash, consumes the token, and increments authVersion', async () => {
    const result = await service.confirmPasswordReset('raw-secret-token', 'NewPassword7');

    expect(result.success).toBe(true);
    expect(mockPrisma.passwordResetToken.findUnique).toHaveBeenCalledWith({
      where: { token: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: resetRecord.id, used: false, expiresAt: { gt: expect.any(Date) } },
      data: { used: true },
    });
    expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: validUser.id, used: false },
      data: { used: true },
    });
    const updateData = mockPrisma.user.update.mock.calls[0][0].data;
    expect(updateData.authVersion).toEqual({ increment: 1 });
    expect(await comparePasswords('NewPassword7', updateData.password)).toBe(true);
    expect(updateData.password).not.toBe('NewPassword7');
  });

  it('rejects reuse of a consumed reset token', async () => {
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue({ ...resetRecord, used: true });

    await expect(service.confirmPasswordReset('raw-secret-token', 'NewPassword7')).rejects.toBeInstanceOf(ValidationError);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects expired reset tokens', async () => {
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue({
      ...resetRecord,
      expiresAt: new Date(Date.now() - 1),
    });

    await expect(service.confirmPasswordReset('raw-secret-token', 'NewPassword7')).rejects.toBeInstanceOf(ValidationError);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it.each(['short7A', 'alllowercase7', 'ALLUPPERCASE7', 'NoNumberHere'])('enforces password strength for %s', async (password) => {
    await expect(service.confirmPasswordReset('raw-secret-token', password)).rejects.toThrow();
    expect(mockPrisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects concurrent token reuse when the atomic claim fails', async () => {
    mockPrisma.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.confirmPasswordReset('raw-secret-token', 'NewPassword7')).rejects.toBeInstanceOf(ValidationError);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('AuthService refresh token rotation', () => {
  let service: AuthService;
  const user = { id: 'user-1', email: 'person@example.com', name: 'Person', authVersion: 1 };
  const refreshToken = 'old-refresh-token';
  const payload = { userId: 'user-1', jti: 'old-jti', authVersion: 1, iat: 1000 };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AuthService(mockPrisma as never);
    mockPrisma.user.findUnique.mockResolvedValue(user);
    verifyRefreshTokenMock.mockResolvedValue(payload);
    isRefreshTokenBlacklistedMock.mockResolvedValue(false);
    blacklistRefreshTokenMock.mockResolvedValue(undefined);
    generateAccessTokenMock.mockReturnValue('new-access-token');
    generateRefreshTokenMock.mockReturnValue('new-refresh-token');
  });

  it('issues a new access/refresh token pair and blacklists the old JTI', async () => {
    const result = await service.refreshAccessToken(refreshToken);

    expect(verifyRefreshTokenMock).toHaveBeenCalledWith(refreshToken);
    expect(isRefreshTokenBlacklistedMock).toHaveBeenCalledWith('old-jti');
    expect(blacklistRefreshTokenMock).toHaveBeenCalledWith('old-jti', expect.any(Date));
    expect(generateAccessTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      jti: expect.any(String),
      authVersion: 1,
    }));
    expect(generateRefreshTokenMock).toHaveBeenCalledWith('user-1', expect.any(String), 1);
    expect(blacklistRefreshTokenMock).toHaveBeenCalledTimes(2);
    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
  });

  it('rejects a blacklisted (revoked) refresh token with 401', async () => {
    isRefreshTokenBlacklistedMock.mockResolvedValue(true);

    await expect(service.refreshAccessToken(refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(generateAccessTokenMock).not.toHaveBeenCalled();
    expect(generateRefreshTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a refresh token with a stale authVersion', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...user, authVersion: 2 });

    await expect(service.refreshAccessToken(refreshToken)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(generateAccessTokenMock).not.toHaveBeenCalled();
    expect(generateRefreshTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a refresh token for a missing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(service.refreshAccessToken(refreshToken)).rejects.toBeInstanceOf(ValidationError);
    expect(generateAccessTokenMock).not.toHaveBeenCalled();
  });
});
