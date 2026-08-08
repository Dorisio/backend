import { z } from 'zod';

export const TipStatus = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type TipStatusType = (typeof TipStatus)[keyof typeof TipStatus];

export const CreateTipSchema = z.object({
  creatorId: z.string().min(1, 'Creator ID is required'),
  amount: z.number().positive('Amount must be greater than 0'),
  message: z.string().optional(),
});

export const UpdateTipStatusSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
});

export type CreateTipRequest = z.infer<typeof CreateTipSchema>;
export type UpdateTipStatusRequest = z.infer<typeof UpdateTipStatusSchema>;

export interface TipResponse {
  id: string;
  fromUserId: string;
  creatorId: string;
  amount: number;
  message: string | null;
  status: TipStatusType;
  createdAt: string;
  updatedAt: string;
}

export interface TipHistoryResponse {
  tips: TipResponse[];
  total: number;
  page: number;
  pageSize: number;
}
