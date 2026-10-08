import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { BaseService } from '../../services/base.service';
import {
  ReferralCodeResponse,
  ReferralTierResponse,
  AffiliateDashboardResponse,
  ProcessCommissionRequest,
  CreateTierRequest,
  UpdateTierRequest,
} from './referral.types';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum referral chain depth to prevent pyramid-scheme patterns. */
const MAX_REFERRAL_DEPTH = 1;

/** Default commission rate applied when no tier is configured (5%). */
const DEFAULT_COMMISSION_RATE = 0.05;

/** A referral code is considered fraudulent if the same IP creates more than
 *  this many accounts within FRAUD_WINDOW_MS. (Structural detection; IP
 *  tracking uses the existing request context and is enforced in the route.) */
const MAX_REFERRALS_PER_CODE_PER_DAY = 20;
const FRAUD_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a human-friendly, URL-safe referral code.
 * Format: 8 uppercase alphanumeric characters (no O/0/I/l to avoid confusion).
 */
function generateCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('');
}

function formatCode(c: { id: string; code: string; userId: string; tierId: string | null; isActive: boolean; usageCount: number; lockedAt: Date | null; lockReason: string | null; createdAt: Date; updatedAt: Date }): ReferralCodeResponse {
  return {
    id: c.id,
    code: c.code,
    userId: c.userId,
    tierId: c.tierId,
    isActive: c.isActive,
    usageCount: c.usageCount,
    lockedAt: c.lockedAt?.toISOString() ?? null,
    lockReason: c.lockReason,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function formatTier(t: { id: string; name: string; description: string | null; commissionRate: number; isDefault: boolean; createdAt: Date; updatedAt: Date }): ReferralTierResponse {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    commissionRate: t.commissionRate,
    isDefault: t.isDefault,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ReferralService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  // ── Code Management ────────────────────────────────────────────────────────

  /**
   * Get (or lazily create) the caller's referral code.
   * A user gets exactly one code; subsequent calls return the existing one.
   */
  async getOrCreateReferralCode(userId: string): Promise<ReferralCodeResponse> {
    return this.executeWithLogging('referral.getOrCreateCode', async () => {
      const existing = await this.prisma.referralCode.findUnique({
        where: { userId },
      });

      if (existing) {
        return formatCode(existing);
      }

      // Assign the default tier if one is configured
      const defaultTier = await this.prisma.referralTier.findFirst({
        where: { isDefault: true },
      });

      // Collision-resistant retry loop (extremely unlikely but safe)
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        try {
          const created = await this.prisma.referralCode.create({
            data: {
              userId,
              code,
              tierId: defaultTier?.id ?? null,
            },
          });
          return formatCode(created);
        } catch (err: unknown) {
          const isPrismaUniqueViolation =
            typeof err === 'object' &&
            err !== null &&
            (err as { code?: string }).code === 'P2002';
          if (!isPrismaUniqueViolation) throw err;
          // code collision - try again
        }
      }
      throw new Error('Failed to generate unique referral code after 5 attempts');
    });
  }

  /**
   * Get a referral code by its string value (public lookup, used at sign-up).
   */
  async getReferralCodeByValue(code: string): Promise<ReferralCodeResponse> {
    return this.executeWithLogging('referral.getCodeByValue', async () => {
      const record = await this.prisma.referralCode.findUnique({
        where: { code },
      });
      if (!record) throw new NotFoundError('Referral code');
      return formatCode(record);
    });
  }

  // ── Referral Registration ──────────────────────────────────────────────────

  /**
   * Record that a new user (`refereeId`) registered via `code`.
   *
   * Fraud guards:
   * 1. A user cannot refer themselves.
   * 2. A user can only be referred once.
   * 3. Locked / inactive codes are rejected.
   * 4. Max-depth check prevents pyramid chains.
   * 5. Velocity check: if a code has been used more than
   *    MAX_REFERRALS_PER_CODE_PER_DAY times in the last 24 h the code is
   *    automatically locked and the registration is rejected.
   */
  async registerReferral(code: string, refereeId: string): Promise<void> {
    return this.executeWithLogging('referral.register', async () => {
      const referralCode = await this.prisma.referralCode.findUnique({
        where: { code },
      });

      if (!referralCode) {
        // Silently skip – unknown codes don't block registration
        logger.warn(`Referral code not found: ${code}`);
        return;
      }

      // Guard: code must be active
      if (!referralCode.isActive || referralCode.lockedAt) {
        throw new ValidationError('Referral code is no longer active');
      }

      // Guard: self-referral
      if (referralCode.userId === refereeId) {
        throw new ValidationError('You cannot use your own referral code');
      }

      // Guard: already referred
      const alreadyReferred = await this.prisma.referral.findUnique({
        where: { refereeId },
      });
      if (alreadyReferred) {
        throw new ConflictError('User has already been referred');
      }

      // Guard: depth check (prevent multi-tier pyramids)
      const referrerReferral = await this.prisma.referral.findUnique({
        where: { refereeId: referralCode.userId },
      });
      const depth = referrerReferral ? referrerReferral.depth + 1 : 1;
      if (depth > MAX_REFERRAL_DEPTH) {
        logger.warn(`Referral depth ${depth} exceeds max ${MAX_REFERRAL_DEPTH}`, {
          refereeId,
          referrerId: referralCode.userId,
        });
        // Still allow the registration but don't create a referral record
        // so no commission flows through multi-tier chains
        return;
      }

      // Fraud: velocity check
      const windowStart = new Date(Date.now() - FRAUD_WINDOW_MS);
      const recentCount = await this.prisma.referral.count({
        where: {
          referralCodeId: referralCode.id,
          createdAt: { gte: windowStart },
        },
      });

      if (recentCount >= MAX_REFERRALS_PER_CODE_PER_DAY) {
        // Lock the code and reject
        await this.prisma.referralCode.update({
          where: { id: referralCode.id },
          data: {
            lockedAt: new Date(),
            lockReason: `Velocity fraud: ${recentCount} registrations in 24h`,
            isActive: false,
          },
        });
        logger.warn(`Referral code locked due to velocity abuse: ${code}`, {
          recentCount,
          referralCodeId: referralCode.id,
        });
        throw new ValidationError('Referral code has been suspended due to suspicious activity');
      }

      // Create the referral + increment usage atomically
      await this.prisma.$transaction([
        this.prisma.referral.create({
          data: {
            referralCodeId: referralCode.id,
            refereeId,
            depth,
            status: 'pending',
          },
        }),
        this.prisma.referralCode.update({
          where: { id: referralCode.id },
          data: { usageCount: { increment: 1 } },
        }),
      ]);

      logger.info(`Referral registered`, {
        refereeId,
        referrerId: referralCode.userId,
        code,
      });
    });
  }

  // ── Commission Processing ──────────────────────────────────────────────────

  /**
   * Called when a tip is confirmed. Looks up whether the tip sender (`refereeUserId`)
   * was referred, and if so calculates and records a commission for their referrer.
   *
   * This is idempotent: the unique constraint on `tipId` prevents double-counting.
   */
  async processCommissionForTip(req: ProcessCommissionRequest): Promise<void> {
    return this.executeWithLogging('referral.processCommission', async () => {
      const { tipId, tipAmount, refereeUserId } = req;

      // Is there a referral for this user?
      const referral = await this.prisma.referral.findUnique({
        where: { refereeId: refereeUserId },
        include: { referralCode: { include: { tier: true } } },
      });

      if (!referral) return;

      // Only process for active referrals (not fraud-flagged)
      if (referral.status === 'fraud') {
        logger.warn(`Skipping commission for fraud-flagged referral`, { referralId: referral.id });
        return;
      }

      // Idempotency: check if commission already exists for this tip
      const existing = await this.prisma.referralCommission.findUnique({
        where: { tipId },
      });
      if (existing) return;

      // Determine commission rate from tier
      const commissionRate =
        referral.referralCode.tier?.commissionRate ?? DEFAULT_COMMISSION_RATE;
      const commissionAmount = Math.round(tipAmount * commissionRate * 1e8) / 1e8;

      const referrerId = referral.referralCode.userId;

      await this.prisma.$transaction([
        // Record the commission
        this.prisma.referralCommission.create({
          data: {
            referralId: referral.id,
            tipId,
            referrerId,
            amount: commissionAmount,
            commissionRate,
            status: 'pending',
          },
        }),
        // Mark referral as converted (first tip confirms conversion)
        ...(referral.status === 'pending'
          ? [
              this.prisma.referral.update({
                where: { id: referral.id },
                data: { status: 'converted', convertedAt: new Date() },
              }),
            ]
          : []),
      ]);

      logger.info(`Commission recorded`, {
        tipId,
        referrerId,
        refereeId: refereeUserId,
        amount: commissionAmount,
        rate: commissionRate,
      });
    });
  }

  /**
   * Mark pending commissions as paid (called by payout flow or admin action).
   * Returns the total amount paid.
   */
  async payoutCommissions(referrerId: string): Promise<{ count: number; totalAmount: number }> {
    return this.executeWithLogging('referral.payoutCommissions', async () => {
      const pending = await this.prisma.referralCommission.findMany({
        where: { referrerId, status: 'pending' },
      });

      if (pending.length === 0) {
        return { count: 0, totalAmount: 0 };
      }

      const ids = pending.map((c) => c.id);
      const totalAmount = pending.reduce((sum, c) => sum + c.amount, 0);

      await this.prisma.referralCommission.updateMany({
        where: { id: { in: ids } },
        data: { status: 'paid', paidAt: new Date() },
      });

      // Update referrals to "rewarded" state
      const referralIds = [...new Set(pending.map((c) => c.referralId))];
      await this.prisma.referral.updateMany({
        where: { id: { in: referralIds } },
        data: { status: 'rewarded' },
      });

      logger.info(`Commission payout completed`, { referrerId, count: ids.length, totalAmount });

      return { count: ids.length, totalAmount };
    });
  }

  // ── Fraud Controls ────────────────────────────────────────────────────────

  /**
   * Admin: lock a referral code with a reason.
   */
  async lockReferralCode(codeId: string, reason: string): Promise<ReferralCodeResponse> {
    return this.executeWithLogging('referral.lockCode', async () => {
      const code = await this.prisma.referralCode.findUnique({ where: { id: codeId } });
      if (!code) throw new NotFoundError('Referral code');

      const updated = await this.prisma.referralCode.update({
        where: { id: codeId },
        data: { isActive: false, lockedAt: new Date(), lockReason: reason },
      });
      return formatCode(updated);
    });
  }

  /**
   * Admin: flag a referral as fraud.
   */
  async flagReferralAsFraud(referralId: string, reason: string): Promise<void> {
    return this.executeWithLogging('referral.flagFraud', async () => {
      const referral = await this.prisma.referral.findUnique({ where: { id: referralId } });
      if (!referral) throw new NotFoundError('Referral');

      await this.prisma.$transaction([
        this.prisma.referral.update({
          where: { id: referralId },
          data: { status: 'fraud' },
        }),
        // Cancel any pending commissions for this referral
        this.prisma.referralCommission.updateMany({
          where: { referralId, status: 'pending' },
          data: { status: 'failed', failReason: reason },
        }),
      ]);

      logger.warn(`Referral flagged as fraud`, { referralId, reason });
    });
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  /**
   * Aggregate affiliate dashboard for a user.
   */
  async getAffiliateDashboard(userId: string): Promise<AffiliateDashboardResponse> {
    return this.executeWithLogging('referral.dashboard', async () => {
      const codeRecord = await this.prisma.referralCode.findUnique({
        where: { userId },
      });

      if (!codeRecord) {
        return {
          referralCode: null,
          stats: {
            totalReferrals: 0,
            convertedReferrals: 0,
            pendingReferrals: 0,
            fraudReferrals: 0,
            totalCommissionsEarned: 0,
            pendingCommissions: 0,
            paidCommissions: 0,
          },
          recentReferrals: [],
          recentCommissions: [],
        };
      }

      const [referrals, commissionStats, recentCommissions] = await Promise.all([
        this.prisma.referral.findMany({
          where: { referralCodeId: codeRecord.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        this.prisma.referralCommission.groupBy({
          by: ['status'],
          where: { referrerId: userId },
          _sum: { amount: true },
          _count: { id: true },
        }),
        this.prisma.referralCommission.findMany({
          where: { referrerId: userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

      // Build per-referral commission totals for display
      const referralIds = referrals.map((r) => r.id);
      const perReferralCommissions = referralIds.length > 0
        ? await this.prisma.referralCommission.groupBy({
            by: ['referralId'],
            where: { referralId: { in: referralIds } },
            _sum: { amount: true },
          })
        : [];

      const commissionByReferral = Object.fromEntries(
        perReferralCommissions.map((c) => [c.referralId, c._sum.amount ?? 0])
      );

      // Aggregate stats
      let totalCommissionsEarned = 0;
      let pendingCommissions = 0;
      let paidCommissions = 0;

      for (const row of commissionStats) {
        const sum = row._sum.amount ?? 0;
        totalCommissionsEarned += sum;
        if (row.status === 'pending') pendingCommissions += sum;
        if (row.status === 'paid') paidCommissions += sum;
      }

      const totalReferrals = referrals.length;
      const convertedReferrals = referrals.filter((r) => r.status === 'converted' || r.status === 'rewarded').length;
      const pendingReferrals = referrals.filter((r) => r.status === 'pending').length;
      const fraudReferrals = referrals.filter((r) => r.status === 'fraud').length;

      return {
        referralCode: formatCode(codeRecord),
        stats: {
          totalReferrals,
          convertedReferrals,
          pendingReferrals,
          fraudReferrals,
          totalCommissionsEarned: Math.round(totalCommissionsEarned * 1e8) / 1e8,
          pendingCommissions: Math.round(pendingCommissions * 1e8) / 1e8,
          paidCommissions: Math.round(paidCommissions * 1e8) / 1e8,
        },
        recentReferrals: referrals.map((r) => ({
          id: r.id,
          refereeId: r.refereeId,
          status: r.status,
          convertedAt: r.convertedAt?.toISOString() ?? null,
          commissionsEarned: commissionByReferral[r.id] ?? 0,
          createdAt: r.createdAt.toISOString(),
        })),
        recentCommissions: recentCommissions.map((c) => ({
          id: c.id,
          referralId: c.referralId,
          tipId: c.tipId,
          referrerId: c.referrerId,
          amount: c.amount,
          commissionRate: c.commissionRate,
          currency: c.currency,
          status: c.status,
          paidAt: c.paidAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
      };
    });
  }

  // ── Admin: Tier Management ────────────────────────────────────────────────

  async listTiers(): Promise<ReferralTierResponse[]> {
    return this.executeWithLogging('referral.listTiers', async () => {
      const tiers = await this.prisma.referralTier.findMany({
        orderBy: { commissionRate: 'asc' },
      });
      return tiers.map(formatTier);
    });
  }

  async createTier(data: CreateTierRequest): Promise<ReferralTierResponse> {
    return this.executeWithLogging('referral.createTier', async () => {
      if (data.commissionRate < 0 || data.commissionRate > 1) {
        throw new ValidationError('Commission rate must be between 0 and 1 (e.g. 0.05 for 5%)');
      }

      // If marking as default, unset any existing default first
      if (data.isDefault) {
        await this.prisma.referralTier.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }

      try {
        const tier = await this.prisma.referralTier.create({
          data: {
            name: data.name,
            description: data.description ?? null,
            commissionRate: data.commissionRate,
            isDefault: data.isDefault ?? false,
          },
        });
        return formatTier(tier);
      } catch (err: unknown) {
        const isPrismaUniqueViolation =
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2002';
        if (isPrismaUniqueViolation) {
          throw new ConflictError(`Tier with name "${data.name}" already exists`);
        }
        throw err;
      }
    });
  }

  async updateTier(tierId: string, data: UpdateTierRequest): Promise<ReferralTierResponse> {
    return this.executeWithLogging('referral.updateTier', async () => {
      const existing = await this.prisma.referralTier.findUnique({ where: { id: tierId } });
      if (!existing) throw new NotFoundError('Referral tier');

      if (data.commissionRate !== undefined && (data.commissionRate < 0 || data.commissionRate > 1)) {
        throw new ValidationError('Commission rate must be between 0 and 1 (e.g. 0.05 for 5%)');
      }

      if (data.isDefault) {
        await this.prisma.referralTier.updateMany({
          where: { isDefault: true, id: { not: tierId } },
          data: { isDefault: false },
        });
      }

      const updated = await this.prisma.referralTier.update({
        where: { id: tierId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.commissionRate !== undefined && { commissionRate: data.commissionRate }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        },
      });

      return formatTier(updated);
    });
  }

  async deleteTier(tierId: string): Promise<void> {
    return this.executeWithLogging('referral.deleteTier', async () => {
      const existing = await this.prisma.referralTier.findUnique({ where: { id: tierId } });
      if (!existing) throw new NotFoundError('Referral tier');
      if (existing.isDefault) {
        throw new ValidationError('Cannot delete the default tier; set another tier as default first');
      }
      await this.prisma.referralTier.delete({ where: { id: tierId } });
    });
  }

  /**
   * Assign a tier to a referral code.
   */
  async assignTierToCode(codeId: string, tierId: string): Promise<ReferralCodeResponse> {
    return this.executeWithLogging('referral.assignTier', async () => {
      const [code, tier] = await Promise.all([
        this.prisma.referralCode.findUnique({ where: { id: codeId } }),
        this.prisma.referralTier.findUnique({ where: { id: tierId } }),
      ]);
      if (!code) throw new NotFoundError('Referral code');
      if (!tier) throw new NotFoundError('Referral tier');

      const updated = await this.prisma.referralCode.update({
        where: { id: codeId },
        data: { tierId },
      });
      return formatCode(updated);
    });
  }
}
