import { z } from 'zod';
import { PaymentMethod, PaymentStatus } from '../../lib/payments/types';

export const MAX_PAYMENT_AMOUNT = 1_000_000;

export const PaymentMethodEnum = z.enum(['card', 'wallet', 'crypto']);

export const CurrencyEnum = z.enum(['USD', 'EUR', 'GBP', 'XLM', 'USDC']);

/**
 * POST /api/v1/payments
 */
export const CreatePaymentSchema = z.object({
  amount: z
    .number()
    .finite('Amount must be a finite number')
    .positive('Amount must be greater than 0')
    .max(MAX_PAYMENT_AMOUNT, `Amount must not exceed ${MAX_PAYMENT_AMOUNT}`),
  currency: CurrencyEnum.default('USD'),
  method: PaymentMethodEnum,
  creatorId: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  /** Optional alternative to the `Idempotency-Key` header. */
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
});

/**
 * POST /api/v1/payments/:id/refund
 */
export const RefundPaymentSchema = z.object({
  amount: z
    .number()
    .finite()
    .positive('Refund amount must be greater than 0')
    .max(MAX_PAYMENT_AMOUNT)
    .optional(),
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent']).optional(),
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
});

export const PaymentIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

export const ListPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z
    .enum([
      'pending',
      'requires_action',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'refunded',
      'partially_refunded',
      'disputed',
    ])
    .optional(),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type RefundPaymentInput = z.infer<typeof RefundPaymentSchema>;
export type ListPaymentsQueryInput = z.infer<typeof ListPaymentsQuerySchema>;

export interface PaymentResponse {
  id: string;
  userId: string;
  creatorId: string | null;
  provider: string;
  providerRef: string | null;
  method: PaymentMethod;
  amount: number;
  currency: string;
  status: PaymentStatus;
  description: string | null;
  clientSecret?: string;
  refundedAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RefundResponse {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  providerRef: string | null;
  createdAt: string;
}

export interface PaymentListResponse {
  payments: PaymentResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface WebhookResult {
  received: true;
  handled: boolean;
  duplicate?: boolean;
  status?: PaymentStatus;
}
