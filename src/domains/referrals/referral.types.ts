// ─── Referral Domain Types ────────────────────────────────────────────────────

export interface ReferralTierResponse {
  id: string;
  name: string;
  description: string | null;
  commissionRate: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralCodeResponse {
  id: string;
  code: string;
  userId: string;
  tierId: string | null;
  isActive: boolean;
  usageCount: number;
  lockedAt: string | null;
  lockReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralResponse {
  id: string;
  referralCodeId: string;
  refereeId: string;
  depth: number;
  status: string;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferralCommissionResponse {
  id: string;
  referralId: string;
  tipId: string;
  referrerId: string;
  amount: number;
  commissionRate: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AffiliateDashboardResponse {
  referralCode: ReferralCodeResponse | null;
  stats: {
    totalReferrals: number;
    convertedReferrals: number;
    pendingReferrals: number;
    fraudReferrals: number;
    totalCommissionsEarned: number;
    pendingCommissions: number;
    paidCommissions: number;
  };
  recentReferrals: Array<{
    id: string;
    refereeId: string;
    status: string;
    convertedAt: string | null;
    commissionsEarned: number;
    createdAt: string;
  }>;
  recentCommissions: ReferralCommissionResponse[];
}

export interface CreateReferralCodeRequest {
  // No extra params needed; userId comes from auth context
}

export interface RegisterWithReferralRequest {
  code: string;
  refereeId: string;
}

export interface ProcessCommissionRequest {
  tipId: string;
  tipAmount: number;
  refereeUserId: string;
}

export interface CreateTierRequest {
  name: string;
  description?: string;
  commissionRate: number;
  isDefault?: boolean;
}

export interface UpdateTierRequest {
  name?: string;
  description?: string;
  commissionRate?: number;
  isDefault?: boolean;
}

export interface LockCodeRequest {
  reason: string;
}
