import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

let prisma: PrismaClient;

// In-memory cache for blacklisted tokens
const blacklistCache = new Map<string, Date>();
let cleanupInterval: NodeJS.Timeout | null = null;

export const initTokenBlacklist = async (prismaClient: PrismaClient): Promise<void> => {
  prisma = prismaClient;
  
  try {
    // Populate cache on startup
    const tokens = await prisma.blacklistedToken.findMany({
      where: { expiresAt: { gt: new Date() } }
    });
    for (const t of tokens) {
      blacklistCache.set(t.token, t.expiresAt);
    }
    logger.info(`Loaded ${tokens.length} blacklisted tokens into cache`);
    
    // Start periodic cleanup (every hour)
    if (!cleanupInterval) {
      cleanupInterval = setInterval(() => {
        cleanupExpiredTokens().catch(err => logger.error('Periodic cleanup error', err));
      }, 60 * 60 * 1000);
      cleanupInterval.unref(); // Don't block process exit
    }
  } catch (error) {
    logger.error('Failed to initialize token blacklist cache:', error);
  }
};

export const blacklistToken = async (token: string, expiresAt: Date): Promise<void> => {
  try {
    await prisma.blacklistedToken.create({
      data: { token, expiresAt },
    });
    blacklistCache.set(token, expiresAt);
    logger.info(`Token blacklisted: expires at ${expiresAt.toISOString()}`);
  } catch (error) {
    logger.error('Failed to blacklist token:', error);
  }
};

export const isTokenBlacklisted = async (token: string): Promise<boolean> => {
  // Check cache first (instant)
  const expiresAt = blacklistCache.get(token);
  if (expiresAt) {
    if (expiresAt > new Date()) {
      return true;
    } else {
      blacklistCache.delete(token); // Cleanup if expired
      return false;
    }
  }
  
  // Fallback to database just in case it was missed
  try {
    if (!prisma) return false;
    const blacklisted = await prisma.blacklistedToken.findUnique({
      where: { token },
    });
    if (blacklisted) {
      if (blacklisted.expiresAt > new Date()) {
        blacklistCache.set(token, blacklisted.expiresAt);
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.error('Failed to check token blacklist:', error);
    return false;
  }
};

export const cleanupExpiredTokens = async (): Promise<void> => {
  try {
    if (!prisma) return;
    
    const now = new Date();
    // Cleanup database
    await prisma.blacklistedToken.deleteMany({
      where: {
        expiresAt: {
          lt: now,
        },
      },
    });
    
    // Cleanup cache
    for (const [token, expiresAt] of blacklistCache.entries()) {
      if (expiresAt < now) {
        blacklistCache.delete(token);
      }
    }
    
    logger.debug('Expired tokens cleaned up');
  } catch (error) {
    logger.error('Failed to clean up expired tokens:', error);
  }
};

export const blacklistRefreshToken = async (jti: string, expiresAt: Date): Promise<void> => {
  const token = `refresh:${jti}`;
  try {
    await prisma.blacklistedToken.create({
      data: { token, expiresAt },
    });
    blacklistCache.set(token, expiresAt);
    logger.info(`Refresh token blacklisted (JTI: ${jti}): expires at ${expiresAt.toISOString()}`);
  } catch (error) {
    logger.error('Failed to blacklist refresh token:', error);
  }
};

export const isRefreshTokenBlacklisted = async (jti: string): Promise<boolean> => {
  const token = `refresh:${jti}`;
  
  // Check cache first
  const expiresAt = blacklistCache.get(token);
  if (expiresAt) {
    if (expiresAt > new Date()) {
      return true;
    } else {
      blacklistCache.delete(token); // Cleanup if expired
      return false;
    }
  }
  
  // Fallback to database
  try {
    if (!prisma) return false;
    const blacklisted = await prisma.blacklistedToken.findUnique({
      where: { token },
    });
    if (blacklisted) {
      if (blacklisted.expiresAt > new Date()) {
        blacklistCache.set(token, blacklisted.expiresAt);
        return true;
      }
    }
    return false;
  } catch (error) {
    logger.error('Failed to check refresh token blacklist:', error);
    return false;
  }
};

export const closeTokenBlacklist = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
};