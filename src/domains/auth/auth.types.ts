import { z } from 'zod';

export const RegisterRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const PasswordResetRequestSchema = z.object({
  email: z.string().email(),
});

export const PasswordResetConfirmRequestSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[0-9]/, 'Password must contain a number'),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;
export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmRequestSchema>;

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
}

/**
 * Wallet request types
 */
export interface GenerateNonceRequest {
  publicKey: string;
}

export interface VerifyWalletRequest {
  publicKey: string;
  nonce: string;
  signedTransaction: string;
}

export interface UpdateWalletNameRequest {
  name: string;
}

export interface WalletResponse {
  id: string;
  publicKey: string;
  name: string | null;
  verified: boolean;
  createdAt: Date;
}