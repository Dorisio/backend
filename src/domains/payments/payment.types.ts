import { z } from 'zod';

/**
 * Tip Status enum representing the lifecycle of a tip transaction
 */
export const TipStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type TipStatusType = (typeof TipStatus)[keyof typeof TipStatus];

/**
 * Zod schema for creating a new tip
 * Validates:
 * - creatorId: must be non-empty string
 * - amount: must be positive number
 * - message: optional string (max 500 chars)
 */
export const CreateTipSchema = z.object({
  creatorId: z.string().min(1, 'Creator ID is required').cuid('Creator ID must be valid'),
  amount: z
    .number()
    .positive('Amount must be greater than 0')
    .max(1000000, 'Amount exceeds maximum limit'),
  message: z.string().max(500, 'Message must be 500 characters or less').optional(),
});

/**
 * Zod schema for updating tip status
 */
export const UpdateTipStatusSchema = z.object({
  status: z.enum(
    ['pending', 'completed', 'failed', 'cancelled'],
    { errorMap: () => ({ message: 'Invalid tip status' }) }
  ),
});

/**
 * Schema for building a payment transaction
 */
export const BuildPaymentTransactionSchema = z.object({
  senderPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
  creatorPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key format'),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Invalid amount format'),
  assetCode: z.string().optional(),
  assetIssuer: z.string().optional(),
});

/**
 * Schema for submitting a signed payment transaction
 */
export const SubmitPaymentTransactionSchema = z.object({
  transactionEnvelope: z.string().min(1, 'Transaction envelope is required'),
});

export type CreateTipRequest = z.infer<typeof CreateTipSchema>;
export type UpdateTipStatusRequest = z.infer<typeof UpdateTipStatusSchema>;
export type BuildPaymentTransactionRequest = z.infer<typeof BuildPaymentTransactionSchema>;
export type SubmitPaymentTransactionRequest = z.infer<typeof SubmitPaymentTransactionSchema>;

/**
 * Response type for a single tip
 */
export interface TipResponse {
  id: string;
  fromUserId: string;
  creatorId: string;
  amount: number;
  message: string | null;
  status: TipStatusType;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Response type for paginated tip history
 */
export interface TipHistoryResponse {
  tips: TipResponse[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Response type for transaction building
 */
export interface BuildTransactionResponse {
  transactionEnvelope: string;
  tipId: string;
  fee: number;
}

/**
 * Response type for transaction submission
 */
export interface SubmitTransactionResponse {
  tipId: string;
  transactionHash: string;
  status: TipStatusType;
}
