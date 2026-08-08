import { z } from 'zod';

export const UpdateUserProfileSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
});

export const UpdateUserSettingsSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  emailDigest: z.enum(['daily', 'weekly', 'never']).optional(),
});

export type UpdateUserProfileRequest = z.infer<typeof UpdateUserProfileSchema>;
export type UpdateUserSettingsRequest = z.infer<typeof UpdateUserSettingsSchema>;

export interface UserProfileResponse {
  id: string;
  email: string;
  name: string | null;
  role: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserSettingsResponse {
  userId: string;
  notificationsEnabled: boolean;
  emailDigest: string;
}

export interface UserTransactionHistoryResponse {
  id: string;
  amount: number;
  status: string;
  creatorId: string;
  creatorName: string;
  message: string | null;
  createdAt: string;
}

export interface PaginatedTransactions {
  transactions: UserTransactionHistoryResponse[];
  total: number;
  page: number;
  pageSize: number;
}
