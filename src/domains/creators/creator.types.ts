import { z } from 'zod';

export const CreateCreatorRequestSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be at most 30 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscore, and dash'),
  displayName: z.string().optional(),
  bio: z.string().max(500, 'Bio must be at most 500 characters').optional(),
});

export const UpdateCreatorRequestSchema = z.object({
  displayName: z.string().optional(),
  bio: z.string().max(500).optional(),
  avatar: z.string().url().optional(),
  isPublic: z.boolean().optional(),
});

export const CreatorPayoutSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  walletAddress: z.string().optional(),
  followerCount: z.number().int().nonnegative().optional(),
  strictTierEnforcement: z.boolean().optional(),
});

export const CalculatePayoutFeeSchema = z.object({
  amount: z.number().positive('Amount must be greater than 0'),
  followerCount: z.number().int().nonnegative().optional(),
  strictTierEnforcement: z.boolean().optional(),
});

export type CreateCreatorRequest = z.infer<typeof CreateCreatorRequestSchema>;
export type UpdateCreatorRequest = z.infer<typeof UpdateCreatorRequestSchema>;
export type CreatorPayoutRequest = z.infer<typeof CreatorPayoutSchema>;
export type CalculatePayoutFeeRequest = z.infer<typeof CalculatePayoutFeeSchema>;

export interface CreatorTierEvaluation {
  claimedTier: string;
  appliedTier: string;
  isEligible: boolean;
  earnings: number;
  followerCount: number;
  feeRate: number;
  feeAmount: number;
  grossAmount: number;
  netAmount: number;
  thresholds: {
    minEarnings: number;
    minFollowers: number;
    feeRate: number;
    name: string;
  };
}

export interface CreatorPayoutResponse {
  id: string;
  amount: number;
  payoutAmount: number;
  grossAmount: number;
  fee: number;
  feeAmount: number;
  feeRate: number;
  netAmount: number;
  tier: string;
  claimedTier: string;
  tierEligible: boolean;
  status: string;
  walletAddress: string;
  pendingBalance: number;
}

export interface CreatorResponse {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatar: string | null;
  verified: boolean;
  isPublic: boolean;
  totalEarnings: number;
  pendingBalance: number;
  createdAt: string;
}

export interface CreatorDashboardResponse {
  creator: CreatorResponse;
  totalTips: number;
  recentTips: Array<{
    id: string;
    amount: number;
    senderName: string | null;
    message: string | null;
    createdAt: string;
  }>;
  earnings: {
    totalEarnings: number;
    pendingBalance: number;
    paidOut: number;
  };
}

export interface PayoutHistoryResponse {
  id: string;
  amount: number;
  status: string;
  createdAt: string;
}
