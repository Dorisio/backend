import jwt, { SignOptions, Secret } from 'jsonwebtoken';
import { config } from '../config';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

export const generateToken = (payload: JwtPayload): string => {
  return jwt.sign(
    payload,
    config.JWT_SECRET as Secret,
    {
      expiresIn: config.JWT_EXPIRES_IN,
    } as any
  );
};

export const verifyToken = (token: string): JwtPayload => {
  return jwt.verify(token, config.JWT_SECRET as Secret) as JwtPayload;
};
