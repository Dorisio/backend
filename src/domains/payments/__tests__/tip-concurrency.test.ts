import { describe, it, expect, beforeEach, vi } from 'vitest';

// The payment service statically imports the BullMQ queue module, which opens a
// Redis connection on import. Mock it so these unit tests stay hermetic.
vi.mock('../../../lib/queue', () => ({
  stellarConfirmationQueue: { add: vi.fn() },
  webhookDispatchQueue: { add: vi.fn() },
}));

// The Stellar SDK/network is not exercised here; stub the transaction helpers so
// submission paths are deterministic.
vi.mock('../../../lib/stellar/transactions', () => ({
  buildPaymentTransaction: vi.fn(),
  submitSignedTransaction: vi.fn(),
  checkTransactionStatus: vi.fn(),
}));

import { PaymentService } from '../payment.service';
import { ConflictError, NotFoundError } from '../../../utils/errors';
import { submitSignedTransaction } from '../../../lib/stellar/transactions';

// ---------------------------------------------------------------------------
// Static (vi.fn) Prisma double for the single-call behaviour tests.
// ---------------------------------------------------------------------------

const mockPrisma = {
  creator: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  wallet: { findFirst: vi.fn() },
  walletFlag: { findFirst: vi.fn() },
  accountFreeze: { findFirst: vi.fn() },
  webhook: { findMany: vi.fn() },
  tip: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn((callback: (tx: any) => Promise<unknown>) => callback(mockPrisma)),
};

function makeTipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tip-123',
    fromUserId: 'user-123',
    creatorId: 'creator-123',
    amount: 100,
    message: null,
    status: 'pending',
    transactionHash: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('createTip idempotency (#48)', () => {
  const userId = 'user-123';
  const creatorId = 'creator-123';
  let service: PaymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PaymentService(mockPrisma as any);
    mockPrisma.user.findUnique.mockResolvedValue({ id: userId });
    mockPrisma.creator.findUnique.mockResolvedValue({
      id: creatorId,
      userId: 'creator-user',
      isPublic: true,
      verified: true,
    });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'wallet-1', publicKey: 'GABC', verified: true });
    mockPrisma.walletFlag.findFirst.mockResolvedValue(null);
    mockPrisma.accountFreeze.findFirst.mockResolvedValue(null);
  });

  it('returns the original tip when an idempotency key is replayed', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(makeTipRow({ id: 'tip-orig' }));

    const result = await service.createTip(userId, {
      creatorId,
      amount: 25,
      idempotencyKey: 'key-12345678',
    });

    expect(result.id).toBe('tip-orig');
    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key replayed by another user', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(makeTipRow({ fromUserId: 'someone-else' }));

    await expect(
      service.createTip(userId, { creatorId, amount: 25, idempotencyKey: 'key-12345678' })
    ).rejects.toThrow(ConflictError);
    expect(mockPrisma.tip.create).not.toHaveBeenCalled();
  });

  it('persists the idempotency key on first submission', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(null);
    mockPrisma.tip.create.mockResolvedValue(makeTipRow({ id: 'tip-new', idempotencyKey: 'key-12345678' }));

    await service.createTip(userId, { creatorId, amount: 25, idempotencyKey: 'key-12345678' });

    expect(mockPrisma.tip.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: 'key-12345678' }),
      })
    );
  });
});

describe('updateTipStatus optimistic locking (#48)', () => {
  let service: PaymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PaymentService(mockPrisma as any);
    mockPrisma.webhook.findMany.mockResolvedValue([]);
  });

  it('guards the update with the version and increments it', async () => {
    mockPrisma.tip.findUnique.mockResolvedValueOnce(makeTipRow({ version: 0 }));
    mockPrisma.tip.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.creator.update.mockResolvedValue({ id: 'creator-123' });

    const result = await service.updateTipStatus('tip-123', { status: 'completed' });

    expect(result.status).toBe('completed');
    expect(mockPrisma.creator.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.tip.updateMany).toHaveBeenCalledWith({
      where: { id: 'tip-123', status: 'pending', version: 0 },
      data: { status: 'completed', version: { increment: 1 } },
    });
  });

  it('throws NotFoundError if the tip does not exist', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(null);

    await expect(service.updateTipStatus('missing', { status: 'completed' })).rejects.toThrow(
      NotFoundError
    );
    expect(mockPrisma.creator.update).not.toHaveBeenCalled();
  });

  it('rejects a duplicate confirmation attempt with a conflict', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(makeTipRow({ status: 'completed', version: 3 }));

    await expect(service.updateTipStatus('tip-123', { status: 'completed' })).rejects.toThrow(
      ConflictError
    );
    expect(mockPrisma.tip.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.creator.update).not.toHaveBeenCalled();
  });

  it('rejects an unexpected status transition', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(makeTipRow({ status: 'cancelled', version: 2 }));

    await expect(service.updateTipStatus('tip-123', { status: 'completed' })).rejects.toThrow(
      ConflictError
    );
    expect(mockPrisma.tip.updateMany).not.toHaveBeenCalled();
  });

  it('retries after a version conflict and credits earnings once', async () => {
    mockPrisma.tip.findUnique
      .mockResolvedValueOnce(makeTipRow({ version: 0 }))
      .mockResolvedValueOnce(makeTipRow({ version: 1 }));
    mockPrisma.tip.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockPrisma.creator.update.mockResolvedValue({ id: 'creator-123' });

    const result = await service.updateTipStatus('tip-123', { status: 'completed' });

    expect(result.status).toBe('completed');
    expect(mockPrisma.tip.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.tip.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'tip-123', status: 'pending', version: 1 },
      data: { status: 'completed', version: { increment: 1 } },
    });
    expect(mockPrisma.creator.update).toHaveBeenCalledTimes(1);
  });

  it('gives up with a conflict after exhausting retries', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(makeTipRow({ version: 0 }));
    mockPrisma.tip.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.updateTipStatus('tip-123', { status: 'completed' })).rejects.toThrow(
      ConflictError
    );
    expect(mockPrisma.creator.update).not.toHaveBeenCalled();
  });
});

describe('submitPaymentTransaction duplicate submission (#48)', () => {
  let service: PaymentService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PaymentService(mockPrisma as any);
  });

  it('replays an already-stored transaction instead of submitting again', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(
      makeTipRow({ transactionHash: 'hash-existing', status: 'pending' })
    );

    const result = await service.submitPaymentTransaction('tip-123', 'envelope');

    expect(result.transactionHash).toBe('hash-existing');
    expect(submitSignedTransaction).not.toHaveBeenCalled();
  });

  it('rejects submission for a tip that is no longer pending', async () => {
    mockPrisma.tip.findUnique.mockResolvedValue(
      makeTipRow({ status: 'completed', transactionHash: null })
    );

    await expect(service.submitPaymentTransaction('tip-123', 'envelope')).rejects.toThrow(
      ConflictError
    );
  });

  it('loses the transactionHash race gracefully and returns the winner', async () => {
    mockPrisma.tip.findUnique
      .mockResolvedValueOnce(makeTipRow({ transactionHash: null }))
      .mockResolvedValueOnce({ id: 'tip-123', status: 'completed', transactionHash: 'hash-race' });
    mockPrisma.tip.update.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    vi.mocked(submitSignedTransaction).mockResolvedValueOnce({
      transactionHash: 'hash-race',
    } as never);

    const result = await service.submitPaymentTransaction('tip-123', 'envelope');

    expect(result.transactionHash).toBe('hash-race');
  });
});

// ---------------------------------------------------------------------------
// Stateful Prisma double that honours optimistic locking, for the true
// concurrency test (several updateTipStatus calls in flight at once).
// ---------------------------------------------------------------------------

function createFakePrisma() {
  const state = {
    tip: makeTipRow(),
    earningsCredited: 0,
    creatorUpdateCalls: 0,
  };

  const tipModel = {
    findUnique: vi.fn(async () => ({ ...state.tip })),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.id !== undefined && where.id !== state.tip.id) return { count: 0 };
      if (where.status !== undefined && where.status !== state.tip.status) return { count: 0 };
      if (where.version !== undefined && where.version !== state.tip.version) return { count: 0 };

      state.tip.status = data.status;
      if (data.version?.increment) state.tip.version += data.version.increment;
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: any) => {
      if (data.transactionHash !== undefined) state.tip.transactionHash = data.transactionHash;
      if (data.status !== undefined) state.tip.status = data.status;
      return { ...state.tip };
    }),
  };

  const creatorModel = {
    update: vi.fn(async ({ data }: any) => {
      state.creatorUpdateCalls += 1;
      state.earningsCredited += data.totalEarnings?.increment ?? 0;
      return { id: state.tip.creatorId };
    }),
  };

  const prisma: any = {
    tip: tipModel,
    creator: creatorModel,
    webhook: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  return { prisma, state, tipModel, creatorModel };
}

describe('Tip concurrent confirmation race (#48)', () => {
  it('credits creator earnings exactly once under concurrent confirmations', async () => {
    const { prisma, state, creatorModel } = createFakePrisma();
    const service = new PaymentService(prisma);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.updateTipStatus('tip-123', { status: 'completed' }))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }

    expect(creatorModel.update).toHaveBeenCalledTimes(1);
    expect(state.earningsCredited).toBe(100);
    expect(state.tip.status).toBe('completed');
    expect(state.tip.version).toBe(1);
  });

  it('retries a lost optimistic lock against fresh state', async () => {
    const { prisma, state, tipModel } = createFakePrisma();
    const service = new PaymentService(prisma);

    tipModel.updateMany
      .mockImplementationOnce(async () => {
        state.tip.version += 1; // another writer commits first
        return { count: 0 };
      })
      .mockImplementationOnce(async ({ where, data }: any) => {
        expect(where.version).toBe(1);
        state.tip.status = data.status;
        state.tip.version += data.version.increment;
        return { count: 1 };
      });

    const result = await service.updateTipStatus('tip-123', { status: 'completed' });

    expect(result.status).toBe('completed');
    expect(tipModel.updateMany).toHaveBeenCalledTimes(2);
    expect(state.earningsCredited).toBe(100);
  });
});
