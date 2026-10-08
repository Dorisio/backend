import { Prisma, PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { LoginRequest, PasswordResetConfirmRequestSchema, RegisterRequest } from './auth.types';
import { TooManyRequestsError, ValidationError } from '../../utils/errors';
import { generateAccessToken, generateRefreshToken } from '../../utils/jwt';
import { hashPassword, comparePasswords } from '../../utils/password';
import { blacklistRefreshToken } from '../../utils/token-blacklist';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { enqueueEmail } from '../../domains/notifications/email';
import { SessionService } from './session.service';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_LIMIT = 3;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;

const hashResetToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const emailFingerprint = (email: string): string => hashResetToken(email).slice(0, 12);

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

      // Send verification email
      await this.sendVerificationEmail(user.id, user.email, user.name);

      return { id: user.id, email: user.email };
    });
  }

  /**
   * Generate and send verification email
   */
  async sendVerificationEmail(userId: string, email: string, name: string | null): Promise<void> {
    return this.executeWithLogging('user.sendVerificationEmail', async () => {
      // Generate secure token
      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Store verification token
      await this.prisma.verificationToken.create({
        data: {
          email,
          token,
          userId,
          expiresAt,
        },
      });

      // Send verification email
      const verificationLink = `${config.FRONTEND_URL || 'http://localhost:3000'}/verify-email?token=${token}`;

      try {
        await enqueueEmail({
          to: email,
          template: 'verification',
          data: {
            name: name || 'there',
            link: verificationLink,
          },
        });

        logger.info(`Verification email sent to ${email}`);
      } catch (error) {
        logger.error(`Failed to send verification email to ${email}:`, error);
        // Don't fail registration if email fails, but log it
      }
    });
  }

  /** Queue a one-time password reset email without revealing account existence. */
  async requestPasswordReset(inputEmail: string): Promise<{ success: true; message: string }> {
    return this.executeWithLogging('user.requestPasswordReset', async () => {
      const email = inputEmail.trim().toLowerCase();
      const now = new Date();
      const windowStart = new Date(now.getTime() - PASSWORD_RESET_WINDOW_MS);
      const rawToken = randomBytes(32).toString('hex');
      const tokenDigest = hashResetToken(rawToken);
      let result:
        | { rateLimited: true }
        | { rateLimited: false; user: { id: string; email: string; name: string | null } | null }
        | undefined;

      // Serializable transactions ensure concurrent requests cannot bypass the
      // per-email limit by all observing the same prior count.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await this.prisma.$transaction(async (tx) => {
            const requests = await tx.passwordResetToken.count({
              where: { email, createdAt: { gte: windowStart } },
            });
            if (requests >= PASSWORD_RESET_LIMIT) return { rateLimited: true as const };

            const user = await tx.user.findFirst({
              where: { email: { equals: email, mode: 'insensitive' } },
              select: { id: true, email: true, name: true },
            });
            await tx.passwordResetToken.create({
              data: {
                email,
                token: tokenDigest,
                userId: user?.id ?? null,
                expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
              },
            });
            return { rateLimited: false as const, user };
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          break;
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034' &&
            attempt < 2
          ) {
            continue;
          }
          throw error;
        }
      }

      if (!result || result.rateLimited) {
        logger.warn({ emailFingerprint: emailFingerprint(email), outcome: 'rate_limited' }, 'Password reset request');
        throw new TooManyRequestsError('Too many password reset requests. Try again later.');
      }

      const successfulResetRequest = result as Extract<typeof result, { rateLimited: false }>;

      logger.info(
        { emailFingerprint: emailFingerprint(email), accountExists: Boolean(successfulResetRequest.user), outcome: 'requested' },
        'Password reset request'
      );

      if (successfulResetRequest.user) {
        const link = `${config.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;
        try {
          await enqueueEmail({
            to: successfulResetRequest.user.email,
            template: 'password-reset',
            data: { name: successfulResetRequest.user.name || 'there', link },
            userId: successfulResetRequest.user.id,
          });
        } catch (error) {
          logger.error({ emailFingerprint: emailFingerprint(email), error }, 'Failed to queue password reset email');
        }
      }

      return { success: true, message: 'If an account exists for that email, reset instructions have been sent.' };
    });
  }

  /** Consume a reset token exactly once and revoke every JWT issued to the user. */
  async confirmPasswordReset(token: string, newPassword: string): Promise<{ success: true; message: string }> {
    return this.executeWithLogging('user.confirmPasswordReset', async () => {
      logger.info({ outcome: 'attempted' }, 'Password reset completion attempt');
      PasswordResetConfirmRequestSchema.parse({ token, newPassword });
      const tokenDigest = hashResetToken(token);
      const resetToken = await this.prisma.passwordResetToken.findUnique({ where: { token: tokenDigest } });
      const now = new Date();

      if (!resetToken || resetToken.used || resetToken.expiresAt <= now || !resetToken.userId) {
        logger.warn({ outcome: 'rejected' }, 'Password reset completion attempt');
        throw new ValidationError('Invalid or expired password reset token');
      }

      const passwordHash = await hashPassword(newPassword);
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: resetToken.id, used: false, expiresAt: { gt: now } },
          data: { used: true },
        });
        if (claimed.count !== 1) {
          throw new ValidationError('Invalid or expired password reset token');
        }

        await tx.user.update({
          where: { id: resetToken.userId! },
          data: { password: passwordHash, authVersion: { increment: 1 } },
        });
        // Other outstanding reset links are no longer valid after a password change.
        await tx.passwordResetToken.updateMany({
          where: { userId: resetToken.userId, used: false },
          data: { used: true },
        });
      });

      logger.info({ userId: resetToken.userId, outcome: 'succeeded' }, 'Password reset completed');
      return { success: true, message: 'Password has been reset successfully.' };
    });
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string): Promise<{ success: boolean; message: string }> {
    return this.executeWithLogging('user.verifyEmail', async () => {
      const verificationToken = await this.prisma.verificationToken.findUnique({
        where: { token },
      });

      if (!verificationToken) {
        throw new ValidationError('Invalid verification token');
      }

      if (verificationToken.used) {
        throw new ValidationError('Verification token already used');
      }

      if (verificationToken.expiresAt < new Date()) {
        throw new ValidationError('Verification token has expired');
      }

      // Mark token as used
      await this.prisma.verificationToken.update({
        where: { id: verificationToken.id },
        data: { used: true },
      });

      // Update user verification status
      await this.prisma.user.update({
        where: { id: verificationToken.userId },
        data: { verified: true },
      });

      logger.info(`Email verified for user ${verificationToken.userId}`);

      return {
        success: true,
        message: 'Email verified successfully',
      };
    });
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email: string): Promise<{ success: boolean; message: string }> {
    return this.executeWithLogging('user.resendVerificationEmail', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw new ValidationError('User not found');
      }

      if (user.verified) {
        throw new ValidationError('Email already verified');
      }

      // Send new verification email
      await this.sendVerificationEmail(user.id, user.email, user.name);

      return {
        success: true,
        message: 'Verification email sent',
      };
    });
  }

  async login(data: LoginRequest, metadata: { ipAddress?: string; userAgent?: string; device?: string } = {}): Promise<{
    user: { id: string; email: string; name: string | null; role: string };
    accessToken: string;
    refreshToken: string;
  }> {
    return this.executeWithLogging('user.login', async () => {
      const user = await this.prisma.user.findUnique({
        where: { email: data.email },
      });

      if (!user) {
        await (this.prisma as any).authAttempt?.create({ data: { email: data.email, ipAddress: metadata.ipAddress ?? 'unknown', action: 'login', reason: 'unknown_user' } });
        throw new ValidationError('Invalid email or password');
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await (this.prisma as any).authAttempt?.create({ data: { email: data.email, ipAddress: metadata.ipAddress ?? 'unknown', action: 'login', reason: 'locked' } });
        throw new TooManyRequestsError('Account temporarily locked. Check your email or try again later.');
      }

      const isPasswordValid = await comparePasswords(data.password, user.password);
      if (!isPasswordValid) {
        const attempts = user.failedLoginAttempts + 1;
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
        await (this.prisma as any).user.update?.({ where: { id: user.id }, data: { failedLoginAttempts: lockedUntil ? 0 : attempts, lockedUntil } });
        await (this.prisma as any).authAttempt?.create({ data: { email: data.email, ipAddress: metadata.ipAddress ?? 'unknown', action: 'login', reason: 'invalid_password' } });
        if (lockedUntil) {
          try { await enqueueEmail({ to: user.email, template: 'account-locked', data: { name: user.name || 'there', unlockAt: lockedUntil.toISOString() }, userId: user.id }); } catch (error) { logger.warn({ error }, 'Unable to queue account lockout notification'); }
        }
        throw new ValidationError('Invalid email or password');
      }

      await (this.prisma as any).user.update?.({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
      await (this.prisma as any).authAttempt?.create({ data: { email: data.email, ipAddress: metadata.ipAddress ?? 'unknown', action: 'login', success: true } });

      const jti = randomUUID();
      
      const accessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        jti,
        authVersion: user.authVersion,
      });

      const refreshToken = generateRefreshToken(user.id, jti, user.authVersion);

      if ((this.prisma as any).session) await new SessionService(this.prisma).create(user.id, metadata);

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
      if ((payload.authVersion ?? 0) !== user.authVersion) {
        throw new ValidationError('Refresh token has been revoked');
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
        authVersion: user.authVersion,
      });

      const newRefreshToken = generateRefreshToken(user.id, newJti, user.authVersion);

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
