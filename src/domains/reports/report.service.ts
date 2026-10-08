import { PrismaClient } from '@prisma/client';

export interface FinancialReport {
  period: { from: string; to: string };
  currency: string;
  grossRevenue: number;
  completedPayouts: number;
  pendingPayouts: number;
  transactionCount: number;
  auditEventCount: number;
  transactions: Array<{
    id: string;
    type: 'revenue' | 'payout';
    amount: number;
    status: string;
    createdAt: string;
    reference: string;
  }>;
}

export class ReportService {
  constructor(private readonly prisma: PrismaClient) {}

  async financialReport(creatorId: string, from: Date, to: Date): Promise<FinancialReport> {
    const [tips, payouts, auditEventCount] = await Promise.all([
      this.prisma.tip.findMany({
        where: { creatorId, status: { in: ['confirmed', 'completed'] }, createdAt: { gte: from, lt: to } },
        select: { id: true, amount: true, status: true, createdAt: true, transactionHash: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.payout.findMany({
        where: { creatorId, createdAt: { gte: from, lt: to } },
        select: { id: true, amount: true, status: true, createdAt: true, transactionHash: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.paymentEvent.count({ where: { payment: { creatorId }, createdAt: { gte: from, lt: to } } }),
    ]);

    const transactions = [
      ...tips.map((tip) => ({
        id: tip.id,
        type: 'revenue' as const,
        amount: tip.amount,
        status: tip.status,
        createdAt: tip.createdAt.toISOString(),
        reference: tip.transactionHash ?? tip.id,
      })),
      ...payouts.map((payout) => ({
        id: payout.id,
        type: 'payout' as const,
        amount: payout.amount,
        status: payout.status,
        createdAt: payout.createdAt.toISOString(),
        reference: payout.transactionHash ?? payout.id,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const sum = (items: Array<{ amount: number }>) =>
      Math.round(items.reduce((total, item) => total + item.amount, 0) * 100) / 100;
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      currency: 'USD',
      grossRevenue: sum(tips),
      completedPayouts: sum(payouts.filter((payout) => payout.status === 'completed')),
      pendingPayouts: sum(payouts.filter((payout) => payout.status === 'pending' || payout.status === 'processing')),
      transactionCount: transactions.length,
      auditEventCount,
      transactions,
    };
  }
}

export function toCsv(report: FinancialReport): string {
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ['id', 'type', 'amount', 'status', 'created_at', 'reference'],
    ...report.transactions.map((row) => [row.id, row.type, row.amount, row.status, row.createdAt, row.reference]),
  ];
  return rows.map((row) => row.map(escape).join(',')).join('\n') + '\n';
}
