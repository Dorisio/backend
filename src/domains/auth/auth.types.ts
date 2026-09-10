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

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface AuthResponse {
  token: string;
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
