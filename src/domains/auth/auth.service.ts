import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { RegisterRequest, LoginRequest } from './auth.types';
import { ValidationError } from '../../utils/errors';
import { generateAccessToken, generateRefreshToken } from '../../utils/jwt';
import { hashPassword, comparePasswords } from '../../utils/password';
import { blacklistRefreshToken } from '../../utils/token-blacklist';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { randomUUID } from 'node:crypto';

export class AuthService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async register(data: RegisterRequest): Promise<{ id: string; email: string }> {
    return this.executeWithLogging('user.register', async () => {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (existingUser) {
        throw new ValidationError('Email already registered');
      }

      const hashedPassword = await hashPassword(data.password);

      const user = await this.prisma.user.create({
        data: {
          email: data.email,
          password: hashedPassword,
          name: data.name,
          role: 'fan',
        },
      });

      return { id: user.id, email: user.email };
    });
  }

  async login(data: LoginRequest): Promise<{
    user: { id: string; email: string; name: string | null; role: string };
    accessToken: string;
    refreshToken: string;
  }> {
    return this.executeWithLogging('user.login', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (!user) {
        throw new ValidationError('Invalid email or password');
      }

      const isPasswordValid = await comparePasswords(data.password, user.password);
      if (!isPasswordValid) {
        throw new ValidationError('Invalid email or password');
      }

      const jti = randomUUID();
      
      const accessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        jti,
      });

      const refreshToken = generateRefreshToken(user.id, jti);

      // Store refresh token expiry in blacklist for rotation
      const refreshExpiryMs = parseExpiryToMs(config.JWT_REFRESH_EXPIRES_IN);
      const expiresAt = new Date(Date.now() + refreshExpiryMs);
      await blacklistRefreshToken(jti, expiresAt);

      return {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        accessToken,
        refreshToken,
      };
    });
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    return this.executeWithLogging('user.refreshToken', async () => {
      const { verifyRefreshToken } = await import('../../utils/jwt');
      const { isRefreshTokenBlacklisted, blacklistRefreshToken } = await import('../../utils/token-blacklist');
      
      const payload = verifyRefreshToken(refreshToken);
      
      // Check if refresh token is blacklisted (revoked/rotated)
      const isBlacklisted = await isRefreshTokenBlacklisted(payload.jti);
      if (isBlacklisted) {
        throw new ValidationError('Refresh token has been revoked');
      }

      // Verify user still exists
      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      // Revoke old refresh token (rotation)
      const oldRefreshExpiryMs = parseExpiryToMs(config.JWT_REFRESH_EXPIRES_IN);
      const oldExpiresAt = new Date(Date.now() + oldRefreshExpiryMs);
      await blacklistRefreshToken(payload.jti, oldExpiresAt);

      // Issue new tokens with new JTI
      const newJti = randomUUID();
      const newAccessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        jti: newJti,
      });

      const newRefreshToken = generateRefreshToken(user.id, newJti);

      // Store new refresh token expiry
      const newExpiresAt = new Date(Date.now() + oldRefreshExpiryMs);
      await blacklistRefreshToken(newJti, newExpiresAt);

      logger.info('Token refreshed successfully', { userId: user.id });

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    });
  }

  async getByEmail(
    email: string
  ): Promise<{ id: string; email: string; name: string | null; role: string; verified: boolean }> {
    return this.executeWithLogging('user.getByEmail', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        verified: user.verified,
      };
    });
  }
}

/**
 * Parse expiry string like "7d", "24h", "3600" to milliseconds
 */
function parseExpiryToMs(expiryStr: string): number {
  const match = expiryStr.match(/^(\d+)([dhms]?)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';

  switch (unit) {
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'm':
      return value * 60 * 1000;
    case 's':
      return value * 1000;
    default:
      return value * 1000;
  }
}
