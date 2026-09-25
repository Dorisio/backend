import jwt, { SignOptions, Secret, JwtPayload as BaseJwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import { logger } from './logger';

export interface JwtPayload extends BaseJwtPayload {
  userId: string;
  email: string;
  role: string;
  jti?: string;
}

export interface RefreshTokenPayload extends BaseJwtPayload {
  userId: string;
  jti: string;
  iat: number;
}

/**
 * Generate a short-lived access token
 */
export const generateAccessToken = (payload: JwtPayload): string => {
  return jwt.sign(
    payload,
    config.JWT_SECRET as Secret,
    {
      expiresIn: config.JWT_EXPIRES_IN,
    } as SignOptions
  );
};

/**
 * Generate a long-lived refresh token
 */
export const generateRefreshToken = (userId: string, jti: string): string => {
  return jwt.sign(
    { userId, jti } as RefreshTokenPayload,
    config.JWT_SECRET as Secret,
    {
      expiresIn: config.JWT_REFRESH_EXPIRES_IN,
    } as SignOptions
  );
};

/**
 * Verify and decode a token without strict expiration check for grace period handling
 */
export const verifyToken = (token: string): JwtPayload => {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET as Secret) as JwtPayload;
    return decoded;
  } catch (error) {
    logger.warn('Token verification failed', { error: (error as Error).message });
    throw error;
  }
};

/**
 * Verify refresh token and return payload
 */
export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET as Secret) as RefreshTokenPayload;
    return decoded;
  } catch (error) {
    logger.warn('Refresh token verification failed', { error: (error as Error).message });
    throw error;
  }
};