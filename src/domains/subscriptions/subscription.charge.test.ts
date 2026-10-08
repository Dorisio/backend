import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    subscription: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    subscriptionCharge: { upsert: vi.fn(), update: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));

import { prisma } from '../../lib/prisma';
import { chargeSubscription } from './subscription.charge';

const p = prisma as any;
const now = new Date('2026-06-01T12:00:00Z');

const baseSub = {
  id: 'sub1',
  supporterId: 'u1',
  creatorId: 'c1',
  amount: 10,
  interval: 'MONTHLY',
  status: 'ACTIVE',
  discountPercent: 0,
  prorateFirst: false,
  currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
  nextChargeAt: new Date('2026-06-01T00:00:00Z'),
  failedAttempts: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  p.subscriptionCharge.upsert.mockResolvedValue({ id: 'ch1', status: 'PENDING' });
  p.subscriptionCharge.count.mockResolvedValue(0);
});

describe('chargeSubscription', () => {
  it('does nothing when the subscription does not exist', async () => {
    p.subscription.findUnique.mockResolvedValue(null);
    const pay = vi.fn();
    await chargeSubscription('x', now, { pay });
    expect(pay).not.toHaveBeenCalled();
  });

  it.each(['PAUSED', 'CANCELED'])('does not charge a %s subscription', async (status) => {
    p.subscription.findUnique.mockResolvedValue({ ...baseSub, status });
    const pay = vi.fn();
    await chargeSubscription('sub1', now, { pay });
    expect(pay).not.toHaveBeenCalled();
  });

  it('does not charge before it is due', async () => {
    p.subscription.findUnique.mockResolvedValue({
      ...baseSub,
      nextChargeAt: new Date('2026-07-01T00:00:00Z'),
    });
    const pay = vi.fn();
    await chargeSubscription('sub1', now, { pay });
    expect(pay).not.toHaveBeenCalled();
  });

  it('charges once and advances the period on success', async () => {
    p.subscription.findUnique.mockResolvedValue(baseSub);
    const pay = vi.fn().mockResolvedValue({ id: 'tip1' });
    await chargeSubscription('sub1', now, { pay });
    expect(pay).toHaveBeenCalledOnce();
    expect(pay).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10, idempotencyKey: 'ch1' }),
    );
    expect(p.$transaction).toHaveBeenCalledOnce();
  });

  it('applies the discount to the charged amount', async () => {
    p.subscription.findUnique.mockResolvedValue({ ...baseSub, discountPercent: 50 });
    const pay = vi.fn().mockResolvedValue({ id: 'tip1' });
    await chargeSubscription('sub1', now, { pay });
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ amount: 5 }));
  });

  it('never double-charges a period that already succeeded', async () => {
    p.subscription.findUnique.mockResolvedValue(baseSub);
    p.subscriptionCharge.upsert.mockResolvedValue({ id: 'ch1', status: 'SUCCEEDED' });
    const pay = vi.fn();
    await chargeSubscription('sub1', now, { pay });
    expect(pay).not.toHaveBeenCalled();
  });

  it('marks PAST_DUE and schedules a retry after the first failure', async () => {
    p.subscription.findUnique.mockResolvedValue(baseSub);
    const pay = vi.fn().mockRejectedValue(new Error('insufficient funds'));
    await chargeSubscription('sub1', now, { pay });
    expect(p.subscriptionCharge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(p.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PAST_DUE',
          failedAttempts: 1,
          nextChargeAt: new Date(now.getTime() + 86_400_000),
        }),
      }),
    );
  });

  it('cancels the subscription after the retries are exhausted', async () => {
    p.subscription.findUnique.mockResolvedValue({
      ...baseSub,
      status: 'PAST_DUE',
      failedAttempts: 3,
    });
    const pay = vi.fn().mockRejectedValue(new Error('still failing'));
    await chargeSubscription('sub1', now, { pay });
    expect(p.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELED' }),
      }),
    );
  });

  it('prorates the first monthly charge when prorateFirst is set', async () => {
    p.subscription.findUnique.mockResolvedValue({
      ...baseSub,
      amount: 30,
      prorateFirst: true,
      currentPeriodStart: new Date('2026-06-16T00:00:00Z'),
      nextChargeAt: new Date('2026-06-16T00:00:00Z'),
    });
    const pay = vi.fn().mockResolvedValue({ id: 'tip1' });
    await chargeSubscription('sub1', new Date('2026-06-16T00:00:00Z'), { pay });
    // June has 30 days; 15 remain from June 16, so 30 * 15/30 = 15
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ amount: 15 }));
  });
});