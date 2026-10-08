import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../../middleware/auth';
import { formatError, formatSuccess } from '../../types/response';
import { ReportService, toCsv } from './report.service';

type ReportQuery = { from?: string; to?: string; format?: 'json' | 'csv'; year?: string; region?: string };

function period(query: ReportQuery): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error('from and to must be valid dates with from before to');
  }
  return { from, to };
}

export function registerReportRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const service = new ReportService(prisma);
  app.get<{ Querystring: ReportQuery }>(
    '/api/v1/creators/reports/financial',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const creator = request.user && await prisma.creator.findUnique({ where: { userId: request.user.userId } });
      if (!creator) return reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
      try {
        const range = period(request.query);
        const report = await service.financialReport(creator.id, range.from, range.to);
        if (request.query.format === 'csv') {
          return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="financial-report.csv"').send(toCsv(report));
        }
        return reply.send(formatSuccess(report));
      } catch (error) {
        return reply.code(400).send(formatError(error instanceof Error ? error.message : 'Invalid report period', 'INVALID_REPORT_PERIOD'));
      }
    },
  );

  app.get<{ Querystring: ReportQuery }>(
    '/api/v1/creators/reports/tax-document',
    { preHandler: authMiddleware },
    async (request: FastifyRequest<{ Querystring: ReportQuery }>, reply: FastifyReply) => {
      const creator = request.user && await prisma.creator.findUnique({ where: { userId: request.user.userId } });
      if (!creator) return reply.code(404).send(formatError('Creator not found', 'CREATOR_NOT_FOUND'));
      const year = Number(request.query.year ?? new Date().getUTCFullYear());
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.code(400).send(formatError('Year must be between 2000 and 2100', 'INVALID_TAX_YEAR'));
      }
      const report = await service.financialReport(creator.id, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1)));
      return reply.send(formatSuccess({ documentType: '1099-NEC-equivalent', taxYear: year, region: request.query.region ?? 'unspecified', grossRevenue: report.grossRevenue, completedPayouts: report.completedPayouts, taxWithheld: 0, disclaimer: 'This statement is informational and is not tax advice.', auditEventCount: report.auditEventCount }));
    },
  );
}
