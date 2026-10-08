import { prisma } from '../../lib/prisma'; // CHANGE #1: use the path you found with grep
import {
  addInterval,
  applyDiscount,
  monthBounds,
  prorate,
  retryDelayMs,
} from './subscription.billing';
import { emitSubscriptionEvent } from './subscription.events';

export interface PayParams {
  supporterId: string;
  creatorId: string;
  amount: number;
  idempotencyKey: string;
}

/**
 * CHANGE #2: connect this to the repo's existing tip creation.
 * Find it with:  grep -rn "createTip" src
 * Call it here and return { id: <the tip id> }.
 * Throw an Error if the payment fails.
 */
export async function payForSubscription(_params: PayParams): Promise<{ id: string }> {
  throw new Error('payForSubscription is not connected to the tip service yet');
}

export async function chargeSubscription(
  subscriptionId: string,
  now: Date = new Date(),
  deps: { pay: (p: PayParams) => Promise<{ id: string }> } = { pay: payForSubscription },
): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return;
  if (sub.status !== 'ACTIVE' && sub.status !== 'PAST_DUE') return;
  if (sub.nextChargeAt > now) return; // not due yet

  const fullAmount = Number(sub.amount);
  let periodEnd = addInterval(sub.currentPeriodStart, sub.interval);
  let baseAmount = fullAmount;

  if (sub.prorateFirst && sub.interval === 'MONTHLY') {
    const succeeded = await prisma.subscriptionCharge.count({
      where: { subscriptionId: sub.id, status: 'SUCCEEDED' },
    });
    if (succeeded === 0) {
      const { start, end } = monthBounds(sub.currentPeriodStart);
      periodEnd = end;
      baseAmount = prorate(fullAmount, start, end, sub.currentPeriodStart);
    }
  }

  const amount = applyDiscount(baseAmount, sub.discountPercent);
  const attempt = sub.failedAttempts + 1;

  // Unique (subscriptionId, periodStart) means one charge row per period.
  const charge = await prisma.subscriptionCharge.upsert({
    where: {
      subscriptionId_periodStart: {
        subscriptionId: sub.id,
        periodStart: sub.currentPeriodStart,
      },
    },
    create: {
      subscriptionId: sub.id,
      periodStart: sub.currentPeriodStart,
      amount,
      attempt,
    },
    update: { attempt },
  });
  if (charge.status === 'SUCCEEDED') return; // already paid, never double charge

  try {
    const tip = await deps.pay({
      supporterId: sub.supporterId,
      creatorId: sub.creatorId,
      amount,
      idempotencyKey: charge.id,
    });

    await prisma.$transaction([
      prisma.subscriptionCharge.update({
        where: { id: charge.id },
        data: { status: 'SUCCEEDED', tipId: tip.id, failureReason: null },
      }),
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          failedAttempts: 0,
          currentPeriodStart: periodEnd,
          nextChargeAt: periodEnd,
        },
      }),
    ]);
    await emitSubscriptionEvent('subscription.charged', {
      subscriptionId: sub.id,
      amount,
      tipId: tip.id,
    });
  } catch (err) {
    const delay = retryDelayMs(attempt);
    await prisma.subscriptionCharge.update({
      where: { id: charge.id },
      data: { status: 'FAILED', failureReason: String((err as Error)?.message ?? err) },
    });

    if (delay === null) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: now, failedAttempts: attempt },
      });
      await emitSubscriptionEvent('subscription.canceled', {
        subscriptionId: sub.id,
        reason: 'payment_failed',
      });
    } else {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'PAST_DUE',
          failedAttempts: attempt,
          nextChargeAt: new Date(now.getTime() + delay),
        },
      });
      await emitSubscriptionEvent('subscription.payment_failed', {
        subscriptionId: sub.id,
        attempt,
        retryAt: new Date(now.getTime() + delay).toISOString(),
      });
    }
  }
}

/** Called by the worker: charge everything that is due. */
export async function chargeDueSubscriptions(now: Date = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAST_DUE'] }, nextChargeAt: { lte: now } },
    take: 100,
    orderBy: { nextChargeAt: 'asc' },
  });
  for (const s of due) {
    await chargeSubscription(s.id, now);
  }
  return due.length;
}