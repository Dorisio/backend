import { prisma } from '../../lib/prisma'; // CHANGE #1 again: same path
import { Interval, monthlyEquivalent } from './subscription.billing';
import { emitSubscriptionEvent } from './subscription.events';

export class SubscriptionError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const INTERVALS: Interval[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export interface CreateInput {
  creatorId: string;
  amount: number;
  interval: Interval;
  discountPercent?: number;
  prorateFirst?: boolean;
}

export async function createSubscription(supporterId: string, input: CreateInput) {
  if (!input.creatorId || typeof input.creatorId !== 'string') {
    throw new SubscriptionError(400, 'creatorId is required');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new SubscriptionError(400, 'amount must be greater than 0');
  }
  if (!INTERVALS.includes(input.interval)) {
    throw new SubscriptionError(400, 'interval must be DAILY, WEEKLY, MONTHLY or YEARLY');
  }
  const discount = input.discountPercent ?? 0;
  if (!Number.isInteger(discount) || discount < 0 || discount > 100) {
    throw new SubscriptionError(400, 'discountPercent must be an integer from 0 to 100');
  }
  if (input.creatorId === supporterId) {
    throw new SubscriptionError(400, 'You cannot subscribe to yourself');
  }

  const now = new Date();
  const sub = await prisma.subscription.create({
    data: {
      supporterId,
      creatorId: input.creatorId,
      amount: input.amount,
      interval: input.interval,
      discountPercent: discount,
      prorateFirst: input.prorateFirst ?? false,
      currentPeriodStart: now,
      nextChargeAt: now, // first charge is picked up by the worker right away
    },
  });
  await emitSubscriptionEvent('subscription.created', { subscriptionId: sub.id });
  return sub;
}

async function getOwned(id: string, supporterId: string) {
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub || sub.supporterId !== supporterId) {
    throw new SubscriptionError(404, 'Subscription not found');
  }
  return sub;
}

export async function listSubscriptions(supporterId: string) {
  return prisma.subscription.findMany({
    where: { supporterId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getSubscription(id: string, supporterId: string) {
  await getOwned(id, supporterId);
  return prisma.subscription.findUnique({
    where: { id },
    include: { charges: { orderBy: { createdAt: 'desc' } } },
  });
}

export async function getHistory(id: string, supporterId: string) {
  await getOwned(id, supporterId);
  return prisma.subscriptionCharge.findMany({
    where: { subscriptionId: id },
    orderBy: { createdAt: 'desc' },
  });
}

export async function pauseSubscription(id: string, supporterId: string) {
  const sub = await getOwned(id, supporterId);
  if (sub.status !== 'ACTIVE') {
    throw new SubscriptionError(409, `Cannot pause a ${sub.status} subscription`);
  }
  const updated = await prisma.subscription.update({
    where: { id },
    data: { status: 'PAUSED' },
  });
  await emitSubscriptionEvent('subscription.paused', { subscriptionId: id });
  return updated;
}

export async function resumeSubscription(id: string, supporterId: string) {
  const sub = await getOwned(id, supporterId);
  if (sub.status !== 'PAUSED') {
    throw new SubscriptionError(409, `Cannot resume a ${sub.status} subscription`);
  }
  const now = new Date();
  const updated = await prisma.subscription.update({
    where: { id },
    data: {
      status: 'ACTIVE',
      nextChargeAt: sub.nextChargeAt < now ? now : sub.nextChargeAt,
    },
  });
  await emitSubscriptionEvent('subscription.resumed', { subscriptionId: id });
  return updated;
}

export async function cancelSubscription(id: string, supporterId: string) {
  const sub = await getOwned(id, supporterId);
  if (sub.status === 'CANCELED') {
    throw new SubscriptionError(409, 'Subscription is already canceled');
  }
  const updated = await prisma.subscription.update({
    where: { id },
    data: { status: 'CANCELED', canceledAt: new Date() },
  });
  await emitSubscriptionEvent('subscription.canceled', {
    subscriptionId: id,
    reason: 'user_request',
  });
  return updated;
}

export async function getDashboard(creatorId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const [byStatus, active, churned] = await Promise.all([
    prisma.subscription.groupBy({
      by: ['status'],
      where: { creatorId },
      _count: { _all: true },
    }),
    prisma.subscription.findMany({ where: { creatorId, status: 'ACTIVE' } }),
    prisma.subscription.count({
      where: { creatorId, status: 'CANCELED', canceledAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  const mrr = active.reduce(
    (sum, s) =>
      sum +
      monthlyEquivalent(Number(s.amount), s.interval as Interval) *
        (1 - s.discountPercent / 100),
    0,
  );

  return {
    activeSubscribers: active.length,
    monthlyRecurringRevenue: Math.round(mrr * 1e7) / 1e7,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    canceledLast30Days: churned,
  };
}