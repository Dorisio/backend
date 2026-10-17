import { PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { UnauthorizedError, ValidationError } from '../../utils/errors';

export interface ReconciliationStatusBreakdown {
  successful: number;
  failed: number;
  pending: number;
  cancelled: number;
  disputed: number;
  total: number;
}

export interface AssetBreakdownRow {
  assetCode: string;
  assetIssuer: string | null;
  count: number;
  revenue: number;
  fees: number;
}

export interface TierBreakdownRow {
  tier: string;
  count: number;
  revenue: number;
  fees: number;
}

export interface ReconciliationReport {
  period: { from: string; to: string };
  statusBreakdown: ReconciliationStatusBreakdown;
  revenueByAsset: AssetBreakdownRow[];
  revenueByTier: TierBreakdownRow[];
  totalRevenue: number;
  totalFees: number;
  stellarTransactionCount: number;
  totalPayments: number;
}

export interface ReconciliationFilters {
  from: Date;
  to: Date;
}

export class ReconciliationService extends BaseService {
  constructor(private prisma: PrismaClient) {
    super();
  }

  async getReconciliationReport(adminUserId: string, filters: ReconciliationFilters): Promise<ReconciliationReport> {
    return this.executeWithLogging('admin.reconciliation.report', async () => {
      if (!(await this.isAdmin(adminUserId))) {
        throw new UnauthorizedError('Only admins can access the reconciliation report');
      }

      const { from, to } = filters;
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
        throw new ValidationError('from and to must be valid dates with from before to');
      }

      // Status breakdown from Tips (Stellar payments)
      const statusRows = await this.prisma.$queryRaw<
        Array<{ status: string; count: unknown; revenue: unknown }>
      >`
        SELECT "status" as status, COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
        FROM "Tip"
        WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY "status"
      `;

      const breakdown: ReconciliationStatusBreakdown = {
        successful: 0,
        failed: 0,
        pending: 0,
        cancelled: 0,
        disputed: 0,
        total: 0,
      };
      let totalRevenue = 0;
      let totalPayments = 0;

      for (const row of statusRows) {
        const count = Number(row.count) || 0;
        const revenue = Number(row.revenue) || 0;
        totalPayments += count;
        totalRevenue += revenue;
        switch (row.status) {
          case 'completed':
            breakdown.successful += count;
            break;
          case 'failed':
            breakdown.failed += count;
            break;
          case 'pending':
            breakdown.pending += count;
            break;
          case 'cancelled':
            breakdown.cancelled += count;
            break;
          default:
            break;
        }
      }

      // Disputed payments count (Payment model)
      const disputedCount = await this.prisma.payment.count({
        where: { status: 'disputed', createdAt: { gte: from, lt: to } },
      });
      breakdown.disputed = disputedCount;
      breakdown.total = totalPayments;

      // Stellar transaction count: tips that have landed on-chain (have a hash)
      const stellarTransactionCount = await this.prisma.tip.count({
        where: {
          createdAt: { gte: from, lt: to },
          transactionHash: { not: null },
        },
      });

      // Revenue by asset (with estimated fees from StellarAsset.feeBps)
      const assetRows = await this.prisma.$queryRaw<
        Array<{
          assetCode: string;
          assetIssuer: string | null;
          count: unknown;
          revenue: unknown;
          fees: unknown;
        }>
      >`
        SELECT t."assetCode" as assetCode, t."assetIssuer" as assetIssuer,
               COUNT(*) as count,
               COALESCE(SUM(t.amount), 0) as revenue,
               COALESCE(SUM(t.amount * COALESCE(sa."feeBps", 0) / 10000.0), 0) as fees
        FROM "Tip" t
        LEFT JOIN "StellarAsset" sa
          ON sa.code = t."assetCode" AND sa.issuer IS NOT DISTINCT FROM t."assetIssuer"
        WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to}
        GROUP BY t."assetCode", t."assetIssuer"
        ORDER BY revenue DESC
      `;

      const revenueByAsset: AssetBreakdownRow[] = assetRows.map((row) => ({
        assetCode: row.assetCode,
        assetIssuer: row.assetIssuer,
        count: Number(row.count) || 0,
        revenue: Number(row.revenue) || 0,
        fees: Number(row.fees) || 0,
      }));

      // Revenue by creator tier (active subscription)
      const tierRows = await this.prisma.$queryRaw<
        Array<{
          tier: string;
          count: unknown;
          revenue: unknown;
          fees: unknown;
        }>
      >`
        SELECT COALESCE(cs."tier", 'free') as tier,
               COUNT(t.id) as count,
               COALESCE(SUM(t.amount), 0) as revenue,
               COALESCE(SUM(t.amount * COALESCE(sa."feeBps", 0) / 10000.0), 0) as fees
        FROM "Tip" t
        LEFT JOIN "Creator" c ON c.id = t."creatorId"
        LEFT JOIN "CreatorSubscription" cs
          ON cs."creatorId" = c.id AND cs.status = 'active'
        LEFT JOIN "StellarAsset" sa
          ON sa.code = t."assetCode" AND sa.issuer IS NOT DISTINCT FROM t."assetIssuer"
        WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to}
        GROUP BY cs."tier"
        ORDER BY revenue DESC
      `;

      const revenueByTier: TierBreakdownRow[] = tierRows.map((row) => ({
        tier: row.tier,
        count: Number(row.count) || 0,
        revenue: Number(row.revenue) || 0,
        fees: Number(row.fees) || 0,
      }));

      const totalFees = revenueByAsset.reduce((sum, row) => sum + row.fees, 0);

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        statusBreakdown: breakdown,
        revenueByAsset,
        revenueByTier,
        totalRevenue,
        totalFees,
        stellarTransactionCount,
        totalPayments,
      };
    });
  }

  async toCsv(report: ReconciliationReport): Promise<string> {
    const escape = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;

    const lines: string[] = [];

    lines.push('Reconciliation Report');
    lines.push(`Period,${report.period.from},${report.period.to}`);
    lines.push(`Total Payments,${report.totalPayments}`);
    lines.push(`Total Revenue,${report.totalRevenue}`);
    lines.push(`Total Fees,${report.totalFees}`);
    lines.push(`Stellar Transaction Count,${report.stellarTransactionCount}`);
    lines.push('');

    lines.push('Status Breakdown');
    lines.push('status,count,revenue');
    const { statusBreakdown } = report;
    lines.push(`successful,${statusBreakdown.successful},`);
    lines.push(`failed,${statusBreakdown.failed},`);
    lines.push(`pending,${statusBreakdown.pending},`);
    lines.push(`cancelled,${statusBreakdown.cancelled},`);
    lines.push(`disputed,${statusBreakdown.disputed},`);
    lines.push(`total,${statusBreakdown.total},`);
    lines.push('');

    lines.push('Revenue by Asset');
    lines.push('assetCode,assetIssuer,count,revenue,fees');
    for (const row of report.revenueByAsset) {
      lines.push(`${escape(row.assetCode)},${escape(row.assetIssuer)},${row.count},${row.revenue},${row.fees}`);
    }
    lines.push('');

    lines.push('Revenue by Tier');
    lines.push('tier,count,revenue,fees');
    for (const row of report.revenueByTier) {
      lines.push(`${escape(row.tier)},${row.count},${row.revenue},${row.fees}`);
    }

    return lines.join('\n') + '\n';
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'ADMIN';
  }
}
