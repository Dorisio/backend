import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReferralService } from '../referral.service';
import { ValidationError, NotFoundError, ConflictError } from '../../../utils/errors';

// ─── Minimal Prisma mock types ────────────────────────────────────────────────

type MockReferralTier = {
  id: string;
  name: string;
  description: string | null;
  commissionRate: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type MockReferralCode = {
  id: string;
  userId: string;
  code: string;
  tierId: string | null;
  tier?: MockReferralTier | null;
  isActive: boolean;
  lockedAt: Date | null;
  lockReason: string | null;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type MockReferral = {
  id: string;
  referralCodeId: string;
  referralCode?: MockReferralCode & { tier?: MockReferralTier | null };
  refereeId: string;
  depth: number;
  status: string;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MockCommission = {
  id: string;
  referralId: string;
  tipId: string;
  referrerId: string;
  amount: number;
  commissionRate: number;
  currency: string;
  status: string;
  paidAt: Date | null;
  failReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ─── In-memory fake for Prisma ────────────────────────────────────────────────

function makeDate(): Date {
  return new Date('2026-09-27T00:00:00Z');
}

function cuid(): string {
  return Math.random().toString(36).slice(2, 12);
}

class FakePrisma {
  tiers: MockReferralTier[] = [];
  codes: MockReferralCode[] = [];
  referrals: MockReferral[] = [];
  commissions: MockCommission[] = [];

  referralTier = {
    findFirst: vi.fn(async (args?: { where?: { isDefault?: boolean } }) => {
      if (args?.where?.isDefault) {
        return this.tiers.find((t) => t.isDefault) ?? null;
      }
      return this.tiers[0] ?? null;
    }),
    findUnique: vi.fn(async (args: { where: { id?: string; name?: string } }) => {
      const t = args.where.id
        ? this.tiers.find((t) => t.id === args.where.id)
        : this.tiers.find((t) => t.name === args.where.name);
      return t ?? null;
    }),
    findMany: vi.fn(async () => [...this.tiers]),
    create: vi.fn(async (args: { data: Partial<MockReferralTier> }) => {
      if (this.tiers.find((t) => t.name === args.data.name)) {
        const err: Error & { code?: string } = new Error('Unique constraint');
        err.code = 'P2002';
        throw err;
      }
      const tier: MockReferralTier = {
        id: cuid(),
        name: args.data.name!,
        description: args.data.description ?? null,
        commissionRate: args.data.commissionRate!,
        isDefault: args.data.isDefault ?? false,
        createdAt: makeDate(),
        updatedAt: makeDate(),
      };
      this.tiers.push(tier);
      return tier;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<MockReferralTier> }) => {
      const idx = this.tiers.findIndex((t) => t.id === args.where.id);
      if (idx === -1) throw new Error('Not found');
      this.tiers[idx] = { ...this.tiers[idx], ...args.data, updatedAt: makeDate() };
      return this.tiers[idx];
    }),
    updateMany: vi.fn(async (args: { where: { isDefault?: boolean; id?: { not?: string } }; data: Partial<MockReferralTier> }) => {
      this.tiers
        .filter((t) => {
          if (args.where.isDefault !== undefined && t.isDefault !== args.where.isDefault) return false;
          if (args.where.id?.not !== undefined && t.id === args.where.id.not) return false;
          return true;
        })
        .forEach((t) => {
          Object.assign(t, args.data, { updatedAt: makeDate() });
        });
      return { count: 1 };
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const idx = this.tiers.findIndex((t) => t.id === args.where.id);
      if (idx === -1) throw new Error('Not found');
      const [deleted] = this.tiers.splice(idx, 1);
      return deleted;
    }),
  };

  referralCode = {
    findUnique: vi.fn(async (args: { where: { userId?: string; code?: string; id?: string } }) => {
      const c = args.where.userId
        ? this.codes.find((c) => c.userId === args.where.userId)
        : args.where.code
        ? this.codes.find((c) => c.code === args.where.code)
        : this.codes.find((c) => c.id === args.where.id);
      return c ?? null;
    }),
    create: vi.fn(async (args: { data: Partial<MockReferralCode> }) => {
      if (
        args.data.userId && this.codes.find((c) => c.userId === args.data.userId) ||
        args.data.code && this.codes.find((c) => c.code === args.data.code)
      ) {
        const err: Error & { code?: string } = new Error('Unique constraint');
        err.code = 'P2002';
        throw err;
      }
      const code: MockReferralCode = {
        id: cuid(),
        userId: args.data.userId!,
        code: args.data.code!,
        tierId: args.data.tierId ?? null,
        isActive: true,
        lockedAt: null,
        lockReason: null,
        usageCount: 0,
        createdAt: makeDate(),
        updatedAt: makeDate(),
      };
      this.codes.push(code);
      return code;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<MockReferralCode> }) => {
      const idx = this.codes.findIndex((c) => c.id === args.where.id);
      if (idx === -1) throw new Error('Not found');
      this.codes[idx] = { ...this.codes[idx], ...args.data, updatedAt: makeDate() };
      return this.codes[idx];
    }),
  };

  referral = {
    findUnique: vi.fn(async (args: { where: { refereeId?: string; id?: string }; include?: unknown }) => {
      const r = args.where.refereeId
        ? this.referrals.find((r) => r.refereeId === args.where.refereeId)
        : this.referrals.find((r) => r.id === args.where.id);
      if (!r) return null;
      // Simulate includes
      if (args.include) {
        const code = this.codes.find((c) => c.id === r.referralCodeId) ?? null;
        return { ...r, referralCode: code ? { ...code, tier: code.tierId ? this.tiers.find((t) => t.id === code.tierId) ?? null : null } : null };
      }
      return r;
    }),
    count: vi.fn(async (args: { where: { referralCodeId?: string; createdAt?: { gte?: Date } } }) => {
      return this.referrals.filter((r) => {
        if (args.where.referralCodeId && r.referralCodeId !== args.where.referralCodeId) return false;
        if (args.where.createdAt?.gte && r.createdAt < args.where.createdAt.gte) return false;
        return true;
      }).length;
    }),
    create: vi.fn(async (args: { data: Partial<MockReferral> }) => {
      if (args.data.refereeId && this.referrals.find((r) => r.refereeId === args.data.refereeId)) {
        const err: Error & { code?: string } = new Error('Unique constraint');
        err.code = 'P2002';
        throw err;
      }
      const referral: MockReferral = {
        id: cuid(),
        referralCodeId: args.data.referralCodeId!,
        refereeId: args.data.refereeId!,
        depth: args.data.depth ?? 1,
        status: args.data.status ?? 'pending',
        convertedAt: null,
        createdAt: makeDate(),
        updatedAt: makeDate(),
      };
      this.referrals.push(referral);
      return referral;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<MockReferral> }) => {
      const idx = this.referrals.findIndex((r) => r.id === args.where.id);
      if (idx === -1) throw new Error('Not found');
      this.referrals[idx] = { ...this.referrals[idx], ...args.data, updatedAt: makeDate() };
      return this.referrals[idx];
    }),
    updateMany: vi.fn(async (args: { where: { id?: { in?: string[] } }; data: Partial<MockReferral> }) => {
      const ids = args.where.id?.in ?? [];
      this.referrals.filter((r) => ids.includes(r.id)).forEach((r) => Object.assign(r, args.data));
      return { count: ids.length };
    }),
    findMany: vi.fn(async (args?: { where?: { referralCodeId?: string }; take?: number; orderBy?: unknown }) => {
      let result = [...this.referrals];
      if (args?.where?.referralCodeId) {
        result = result.filter((r) => r.referralCodeId === args.where!.referralCodeId);
      }
      return result.slice(0, args?.take ?? result.length);
    }),
  };

  referralCommission = {
    findUnique: vi.fn(async (args: { where: { tipId?: string; id?: string } }) => {
      const c = args.where.tipId
        ? this.commissions.find((c) => c.tipId === args.where.tipId)
        : this.commissions.find((c) => c.id === args.where.id);
      return c ?? null;
    }),
    create: vi.fn(async (args: { data: Partial<MockCommission> }) => {
      const commission: MockCommission = {
        id: cuid(),
        referralId: args.data.referralId!,
        tipId: args.data.tipId!,
        referrerId: args.data.referrerId!,
        amount: args.data.amount!,
        commissionRate: args.data.commissionRate!,
        currency: args.data.currency ?? 'XLM',
        status: args.data.status ?? 'pending',
        paidAt: null,
        failReason: null,
        createdAt: makeDate(),
        updatedAt: makeDate(),
      };
      this.commissions.push(commission);
      return commission;
    }),
    findMany: vi.fn(async (args?: { where?: { referrerId?: string; status?: string }; orderBy?: unknown; take?: number }) => {
      let result = [...this.commissions];
      if (args?.where?.referrerId) result = result.filter((c) => c.referrerId === args.where!.referrerId);
      if (args?.where?.status) result = result.filter((c) => c.status === args.where!.status);
      return result.slice(0, args?.take ?? result.length);
    }),
    updateMany: vi.fn(async (args: { where: { id?: { in?: string[] }; referralId?: string; status?: string }; data: Partial<MockCommission> }) => {
      const ids = args.where.id?.in;
      this.commissions
        .filter((c) => {
          if (ids && !ids.includes(c.id)) return false;
          if (args.where.referralId && c.referralId !== args.where.referralId) return false;
          if (args.where.status && c.status !== args.where.status) return false;
          return true;
        })
        .forEach((c) => Object.assign(c, args.data));
      return { count: 1 };
    }),
    groupBy: vi.fn(async (args: { by: string[]; where?: { referrerId?: string; referralId?: { in?: string[] } }; _sum?: unknown; _count?: unknown }) => {
      const commissions = this.commissions.filter((c) => {
        if (args.where?.referrerId && c.referrerId !== args.where.referrerId) return false;
        if (args.where?.referralId?.in && !args.where.referralId.in.includes(c.referralId)) return false;
        return true;
      });

      if (args.by.includes('status')) {
        const grouped: Record<string, number> = {};
        for (const c of commissions) {
          grouped[c.status] = (grouped[c.status] ?? 0) + c.amount;
        }
        return Object.entries(grouped).map(([status, amount]) => ({
          status,
          _sum: { amount },
          _count: { id: commissions.filter((c) => c.status === status).length },
        }));
      }

      if (args.by.includes('referralId')) {
        const grouped: Record<string, number> = {};
        for (const c of commissions) {
          grouped[c.referralId] = (grouped[c.referralId] ?? 0) + c.amount;
        }
        return Object.entries(grouped).map(([referralId, amount]) => ({
          referralId,
          _sum: { amount },
        }));
      }

      return [];
    }),
  };

  // $transaction: execute all operations in sequence
  $transaction = vi.fn(async (operations: unknown) => {
    if (typeof operations === 'function') {
      return await operations(this);
    }
    if (Array.isArray(operations)) {
      const results = [];
      for (const op of operations) {
        results.push(await op);
      }
      return results;
    }
    return null;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildService(prisma: FakePrisma): ReferralService {
  return new ReferralService(prisma as never);
}

function seedCode(
  prisma: FakePrisma,
  opts: { userId: string; code?: string; isActive?: boolean; tierId?: string; lockedAt?: Date | null }
): MockReferralCode {
  const c: MockReferralCode = {
    id: cuid(),
    userId: opts.userId,
    code: opts.code ?? 'TESTCODE',
    tierId: opts.tierId ?? null,
    isActive: opts.isActive ?? true,
    lockedAt: opts.lockedAt ?? null,
    lockReason: null,
    usageCount: 0,
    createdAt: makeDate(),
    updatedAt: makeDate(),
  };
  prisma.codes.push(c);
  return c;
}

function seedReferral(
  prisma: FakePrisma,
  opts: { referralCodeId: string; refereeId: string; status?: string; depth?: number }
): MockReferral {
  const r: MockReferral = {
    id: cuid(),
    referralCodeId: opts.referralCodeId,
    refereeId: opts.refereeId,
    depth: opts.depth ?? 1,
    status: opts.status ?? 'pending',
    convertedAt: null,
    createdAt: makeDate(),
    updatedAt: makeDate(),
  };
  prisma.referrals.push(r);
  return r;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReferralService.getOrCreateReferralCode', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('creates a code for a user who has none', async () => {
    const result = await service.getOrCreateReferralCode('user-1');
    expect(result.userId).toBe('user-1');
    expect(result.code).toHaveLength(8);
    expect(/^[A-Z0-9]+$/.test(result.code)).toBe(true);
    expect(result.isActive).toBe(true);
    expect(prisma.codes).toHaveLength(1);
  });

  it('returns the existing code on subsequent calls (idempotent)', async () => {
    const first = await service.getOrCreateReferralCode('user-1');
    const second = await service.getOrCreateReferralCode('user-1');
    expect(second.id).toBe(first.id);
    expect(prisma.codes).toHaveLength(1);
  });

  it('assigns the default tier if one exists', async () => {
    const tier: MockReferralTier = {
      id: 'tier-1', name: 'standard', description: null,
      commissionRate: 0.05, isDefault: true, createdAt: makeDate(), updatedAt: makeDate(),
    };
    prisma.tiers.push(tier);
    const result = await service.getOrCreateReferralCode('user-2');
    expect(result.tierId).toBe('tier-1');
  });

  it('codes contain no ambiguous chars (O/0/I/l)', async () => {
    // Generate many codes and verify no ambiguous chars
    for (let i = 0; i < 50; i++) {
      const prismaLocal = new FakePrisma();
      const svc = buildService(prismaLocal);
      const r = await svc.getOrCreateReferralCode(`user-${i}`);
      expect(r.code).not.toMatch(/[OoIl0]/);
    }
  });
});

describe('ReferralService.getReferralCodeByValue', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('returns a code that exists', async () => {
    seedCode(prisma, { userId: 'user-1', code: 'ABCD1234' });
    const result = await service.getReferralCodeByValue('ABCD1234');
    expect(result.code).toBe('ABCD1234');
  });

  it('throws NotFoundError for unknown codes', async () => {
    await expect(service.getReferralCodeByValue('UNKNOWN1')).rejects.toThrow(NotFoundError);
  });
});

describe('ReferralService.registerReferral', () => {
  let prisma: FakePrisma;
  let service: ReferralService;
  let code: MockReferralCode;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
    code = seedCode(prisma, { userId: 'referrer-1', code: 'MYCODE12' });
  });

  it('creates a referral record for a valid registration', async () => {
    await service.registerReferral('MYCODE12', 'referee-1');
    expect(prisma.referrals).toHaveLength(1);
    expect(prisma.referrals[0].refereeId).toBe('referee-1');
    expect(prisma.referrals[0].status).toBe('pending');
    expect(prisma.codes[0].usageCount).toBe(1);
  });

  it('silently skips unknown codes (does not block registration)', async () => {
    await expect(service.registerReferral('BADCODE1', 'referee-1')).resolves.toBeUndefined();
    expect(prisma.referrals).toHaveLength(0);
  });

  it('rejects self-referral (user cannot refer themselves)', async () => {
    await expect(service.registerReferral('MYCODE12', 'referrer-1')).rejects.toThrow(ValidationError);
    expect(prisma.referrals).toHaveLength(0);
  });

  it('rejects a user who has already been referred', async () => {
    await service.registerReferral('MYCODE12', 'referee-1');
    await expect(service.registerReferral('MYCODE12', 'referee-1')).rejects.toThrow(ConflictError);
    expect(prisma.referrals).toHaveLength(1);
  });

  it('rejects locked codes', async () => {
    code.isActive = false;
    code.lockedAt = new Date();
    await expect(service.registerReferral('MYCODE12', 'referee-2')).rejects.toThrow(ValidationError);
  });

  it('rejects inactive codes', async () => {
    code.isActive = false;
    await expect(service.registerReferral('MYCODE12', 'referee-2')).rejects.toThrow(ValidationError);
  });

  it('blocks pyramid chains beyond depth 1 (skips without creating referral)', async () => {
    // referrer-1 was itself referred by someone else (depth 1 already exists)
    const parentCode = seedCode(prisma, { userId: 'grandparent-1', code: 'PARENT12' });
    seedReferral(prisma, { referralCodeId: parentCode.id, refereeId: 'referrer-1', depth: 1 });

    // Now a new user tries to use referrer-1's code → depth would be 2 (exceeds MAX=1)
    await service.registerReferral('MYCODE12', 'referee-deep');
    // Should silently skip (no referral created for this user)
    expect(prisma.referrals.find((r) => r.refereeId === 'referee-deep')).toBeUndefined();
  });

  it('allows depth=1 when referrer was not themselves referred', async () => {
    // referrer-1 is a root referrer (depth 0 chain): should work
    await service.registerReferral('MYCODE12', 'referee-shallow');
    expect(prisma.referrals.find((r) => r.refereeId === 'referee-shallow')).toBeDefined();
  });

  it('locks the code and rejects after velocity limit is hit', async () => {
    // Seed 20 recent referrals on this code to trigger velocity guard
    const windowStart = new Date(Date.now() - 1000); // recent
    for (let i = 0; i < 20; i++) {
      prisma.referrals.push({
        id: cuid(),
        referralCodeId: code.id,
        refereeId: `old-user-${i}`,
        depth: 1,
        status: 'pending',
        convertedAt: null,
        createdAt: windowStart,
        updatedAt: windowStart,
      });
    }
    await expect(service.registerReferral('MYCODE12', 'new-user-99')).rejects.toThrow(ValidationError);
    // Code should be locked
    expect(prisma.codes[0].isActive).toBe(false);
    expect(prisma.codes[0].lockedAt).toBeDefined();
  });
});

describe('ReferralService.processCommissionForTip', () => {
  let prisma: FakePrisma;
  let service: ReferralService;
  let referralCode: MockReferralCode;
  let referral: MockReferral;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
    referralCode = seedCode(prisma, { userId: 'referrer-1', code: 'REFCODE1' });
    referral = seedReferral(prisma, { referralCodeId: referralCode.id, refereeId: 'referee-1' });
  });

  it('creates a commission record for a referred user tip', async () => {
    await service.processCommissionForTip({
      tipId: 'tip-1',
      tipAmount: 100,
      refereeUserId: 'referee-1',
    });

    expect(prisma.commissions).toHaveLength(1);
    expect(prisma.commissions[0].tipId).toBe('tip-1');
    expect(prisma.commissions[0].referrerId).toBe('referrer-1');
    expect(prisma.commissions[0].commissionRate).toBe(0.05); // default rate
    expect(prisma.commissions[0].amount).toBeCloseTo(5); // 5% of 100
    expect(prisma.commissions[0].status).toBe('pending');
  });

  it('uses the tier commission rate when set', async () => {
    const tier: MockReferralTier = {
      id: 'tier-gold', name: 'gold', description: null,
      commissionRate: 0.1, isDefault: false, createdAt: makeDate(), updatedAt: makeDate(),
    };
    prisma.tiers.push(tier);
    referralCode.tierId = tier.id;
    referralCode.tier = tier;

    await service.processCommissionForTip({
      tipId: 'tip-gold',
      tipAmount: 200,
      refereeUserId: 'referee-1',
    });

    expect(prisma.commissions[0].commissionRate).toBe(0.1);
    expect(prisma.commissions[0].amount).toBeCloseTo(20); // 10% of 200
  });

  it('is idempotent: does not create duplicate commission for the same tip', async () => {
    await service.processCommissionForTip({ tipId: 'tip-1', tipAmount: 100, refereeUserId: 'referee-1' });
    await service.processCommissionForTip({ tipId: 'tip-1', tipAmount: 100, refereeUserId: 'referee-1' });
    expect(prisma.commissions).toHaveLength(1);
  });

  it('does nothing when the user was not referred', async () => {
    await service.processCommissionForTip({ tipId: 'tip-1', tipAmount: 100, refereeUserId: 'not-referred' });
    expect(prisma.commissions).toHaveLength(0);
  });

  it('skips commission for fraud-flagged referrals', async () => {
    referral.status = 'fraud';
    await service.processCommissionForTip({ tipId: 'tip-1', tipAmount: 100, refereeUserId: 'referee-1' });
    expect(prisma.commissions).toHaveLength(0);
  });

  it('marks referral as converted on first commission', async () => {
    expect(referral.status).toBe('pending');
    await service.processCommissionForTip({ tipId: 'tip-1', tipAmount: 100, refereeUserId: 'referee-1' });
    const updated = prisma.referrals.find((r) => r.id === referral.id);
    expect(updated?.status).toBe('converted');
    expect(updated?.convertedAt).toBeDefined();
  });

  it('does not re-convert an already-converted referral', async () => {
    referral.status = 'converted';
    referral.convertedAt = new Date();
    await service.processCommissionForTip({ tipId: 'tip-2', tipAmount: 50, refereeUserId: 'referee-1' });
    // Commission still recorded, but referral status stays converted
    expect(prisma.commissions).toHaveLength(1);
    expect(prisma.referrals.find((r) => r.id === referral.id)?.status).toBe('converted');
  });
});

describe('ReferralService.payoutCommissions', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  function seedCommission(prisma: FakePrisma, referralId: string, referrerId: string, amount: number, status = 'pending'): MockCommission {
    const c: MockCommission = {
      id: cuid(), referralId, tipId: cuid(), referrerId,
      amount, commissionRate: 0.05, currency: 'XLM',
      status, paidAt: null, failReason: null,
      createdAt: makeDate(), updatedAt: makeDate(),
    };
    prisma.commissions.push(c);
    return c;
  }

  it('marks all pending commissions as paid and returns totals', async () => {
    seedCommission(prisma, 'ref-1', 'referrer-1', 5);
    seedCommission(prisma, 'ref-2', 'referrer-1', 10);

    const result = await service.payoutCommissions('referrer-1');
    expect(result.count).toBe(2);
    expect(result.totalAmount).toBeCloseTo(15);
    prisma.commissions.forEach((c) => {
      if (c.referrerId === 'referrer-1') {
        expect(c.status).toBe('paid');
      }
    });
  });

  it('returns zero when there are no pending commissions', async () => {
    const result = await service.payoutCommissions('referrer-1');
    expect(result).toEqual({ count: 0, totalAmount: 0 });
  });

  it('does not pay another referrer\'s commissions', async () => {
    seedCommission(prisma, 'ref-1', 'referrer-2', 50);
    const result = await service.payoutCommissions('referrer-1');
    expect(result).toEqual({ count: 0, totalAmount: 0 });
    expect(prisma.commissions[0].status).toBe('pending');
  });
});

describe('ReferralService.lockReferralCode', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('locks an active code', async () => {
    const code = seedCode(prisma, { userId: 'user-1', code: 'LOCKME12' });
    const result = await service.lockReferralCode(code.id, 'Suspected abuse');
    expect(result.isActive).toBe(false);
    expect(result.lockReason).toBe('Suspected abuse');
    expect(result.lockedAt).not.toBeNull();
  });

  it('throws NotFoundError for unknown code id', async () => {
    await expect(service.lockReferralCode('nonexistent', 'reason')).rejects.toThrow(NotFoundError);
  });
});

describe('ReferralService.flagReferralAsFraud', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('flags a referral as fraud and cancels pending commissions', async () => {
    const code = seedCode(prisma, { userId: 'user-1', code: 'FRAUDME1' });
    const referral = seedReferral(prisma, { referralCodeId: code.id, refereeId: 'bad-user' });
    prisma.commissions.push({
      id: cuid(), referralId: referral.id, tipId: 'tip-1',
      referrerId: 'user-1', amount: 10, commissionRate: 0.05, currency: 'XLM',
      status: 'pending', paidAt: null, failReason: null,
      createdAt: makeDate(), updatedAt: makeDate(),
    });

    await service.flagReferralAsFraud(referral.id, 'Bot accounts detected');

    expect(prisma.referrals[0].status).toBe('fraud');
    expect(prisma.commissions[0].status).toBe('failed');
    expect(prisma.commissions[0].failReason).toBe('Bot accounts detected');
  });

  it('throws NotFoundError for unknown referral id', async () => {
    await expect(service.flagReferralAsFraud('nonexistent', 'reason')).rejects.toThrow(NotFoundError);
  });
});

describe('ReferralService tier CRUD', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('creates a tier', async () => {
    const tier = await service.createTier({ name: 'silver', commissionRate: 0.07 });
    expect(tier.name).toBe('silver');
    expect(tier.commissionRate).toBe(0.07);
  });

  it('rejects commissionRate outside [0,1]', async () => {
    await expect(service.createTier({ name: 'bad', commissionRate: 1.5 })).rejects.toThrow(ValidationError);
    await expect(service.createTier({ name: 'neg', commissionRate: -0.1 })).rejects.toThrow(ValidationError);
  });

  it('rejects duplicate tier names', async () => {
    await service.createTier({ name: 'silver', commissionRate: 0.07 });
    await expect(service.createTier({ name: 'silver', commissionRate: 0.08 })).rejects.toThrow(ConflictError);
  });

  it('unsets previous default when creating a new default', async () => {
    const t1 = await service.createTier({ name: 'standard', commissionRate: 0.05, isDefault: true });
    expect(t1.isDefault).toBe(true);
    const t2 = await service.createTier({ name: 'gold', commissionRate: 0.1, isDefault: true });
    expect(t2.isDefault).toBe(true);
    // updateMany was called to unset the old default
    expect(prisma.referralTier.updateMany).toHaveBeenCalled();
  });

  it('lists all tiers', async () => {
    await service.createTier({ name: 'a', commissionRate: 0.03 });
    await service.createTier({ name: 'b', commissionRate: 0.07 });
    const tiers = await service.listTiers();
    expect(tiers).toHaveLength(2);
  });

  it('updates a tier', async () => {
    const t = await service.createTier({ name: 'orig', commissionRate: 0.05 });
    const updated = await service.updateTier(t.id, { commissionRate: 0.08 });
    expect(updated.commissionRate).toBe(0.08);
  });

  it('throws NotFoundError when updating unknown tier', async () => {
    await expect(service.updateTier('nonexistent', { commissionRate: 0.05 })).rejects.toThrow(NotFoundError);
  });

  it('deletes a non-default tier', async () => {
    await service.createTier({ name: 'default', commissionRate: 0.05, isDefault: true });
    const t2 = await service.createTier({ name: 'deletable', commissionRate: 0.03 });
    await expect(service.deleteTier(t2.id)).resolves.toBeUndefined();
    expect(prisma.tiers.find((t) => t.id === t2.id)).toBeUndefined();
  });

  it('prevents deleting the default tier', async () => {
    const t = await service.createTier({ name: 'def', commissionRate: 0.05, isDefault: true });
    await expect(service.deleteTier(t.id)).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError when deleting unknown tier', async () => {
    await expect(service.deleteTier('nonexistent')).rejects.toThrow(NotFoundError);
  });
});

describe('ReferralService.assignTierToCode', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('assigns a tier to a code', async () => {
    const code = seedCode(prisma, { userId: 'user-1', code: 'ASSIGN12' });
    const tier: MockReferralTier = {
      id: 'tier-x', name: 'tier-x', description: null,
      commissionRate: 0.08, isDefault: false, createdAt: makeDate(), updatedAt: makeDate(),
    };
    prisma.tiers.push(tier);

    const result = await service.assignTierToCode(code.id, tier.id);
    expect(result.tierId).toBe(tier.id);
  });

  it('throws NotFoundError if code not found', async () => {
    const tier: MockReferralTier = {
      id: 'tier-x', name: 'tier-x', description: null,
      commissionRate: 0.08, isDefault: false, createdAt: makeDate(), updatedAt: makeDate(),
    };
    prisma.tiers.push(tier);
    await expect(service.assignTierToCode('bad-id', tier.id)).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError if tier not found', async () => {
    const code = seedCode(prisma, { userId: 'user-1', code: 'ASSIGN12' });
    await expect(service.assignTierToCode(code.id, 'bad-tier')).rejects.toThrow(NotFoundError);
  });
});

describe('ReferralService.getAffiliateDashboard', () => {
  let prisma: FakePrisma;
  let service: ReferralService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = buildService(prisma);
  });

  it('returns empty dashboard when user has no referral code', async () => {
    const dash = await service.getAffiliateDashboard('user-no-code');
    expect(dash.referralCode).toBeNull();
    expect(dash.stats.totalReferrals).toBe(0);
    expect(dash.stats.totalCommissionsEarned).toBe(0);
    expect(dash.recentReferrals).toHaveLength(0);
    expect(dash.recentCommissions).toHaveLength(0);
  });

  it('aggregates stats correctly', async () => {
    const code = seedCode(prisma, { userId: 'referrer-1', code: 'DASH1234' });
    seedReferral(prisma, { referralCodeId: code.id, refereeId: 'ref-a', status: 'converted' });
    seedReferral(prisma, { referralCodeId: code.id, refereeId: 'ref-b', status: 'pending' });
    seedReferral(prisma, { referralCodeId: code.id, refereeId: 'ref-c', status: 'fraud' });

    const dash = await service.getAffiliateDashboard('referrer-1');

    expect(dash.referralCode?.code).toBe('DASH1234');
    expect(dash.stats.totalReferrals).toBe(3);
    expect(dash.stats.convertedReferrals).toBe(1);
    expect(dash.stats.pendingReferrals).toBe(1);
    expect(dash.stats.fraudReferrals).toBe(1);
    expect(dash.recentReferrals).toHaveLength(3);
  });

  it('includes commission stats when commissions exist', async () => {
    const code = seedCode(prisma, { userId: 'referrer-2', code: 'COMM1234' });
    const referral = seedReferral(prisma, { referralCodeId: code.id, refereeId: 'ref-d', status: 'converted' });
    prisma.commissions.push({
      id: cuid(), referralId: referral.id, tipId: 'tip-1',
      referrerId: 'referrer-2', amount: 15, commissionRate: 0.05, currency: 'XLM',
      status: 'pending', paidAt: null, failReason: null,
      createdAt: makeDate(), updatedAt: makeDate(),
    });

    const dash = await service.getAffiliateDashboard('referrer-2');
    expect(dash.stats.pendingCommissions).toBeCloseTo(15);
    expect(dash.stats.totalCommissionsEarned).toBeCloseTo(15);
    expect(dash.recentCommissions).toHaveLength(1);
  });
});
