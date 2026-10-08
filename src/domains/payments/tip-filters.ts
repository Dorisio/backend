import type { Prisma } from '@prisma/client';

/**
 * Filtering / search support for tip listings (#56).
 *
 * Tip listings used to expose pagination and a single `status` filter, so any
 * other slice (date window, amount band, message text, sender, creator) meant
 * fetching the whole table and filtering in memory — which is exactly the full
 * scan the issue calls out.
 *
 * Everything here builds a Prisma `where` clause, so the database does the
 * filtering, and the same builder is shared by every listing route so the
 * endpoints cannot drift apart.
 */

/** Longest accepted free-text search term. Guards against expensive scans. */
export const TIP_TEXT_SEARCH_MAX_LENGTH = 200;

export interface TipFilterInput {
  status?: string;
  /** Inclusive lower bound on `createdAt` (ISO-8601). */
  minDate?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601). */
  maxDate?: string;
  /** Inclusive lower bound on `amount`. */
  minAmount?: number;
  /** Inclusive upper bound on `amount`. */
  maxAmount?: number;
  /** Free-text search over the tip message, id and transaction hash. */
  query?: string;
  /** Restrict to tips sent by this user. */
  fromUserId?: string;
  /** Restrict to tips received by this creator. */
  creatorId?: string;
}

/**
 * Merge a base scope (`{ creatorId }`, `{ fromUserId: userId }`, …) with the
 * caller's filters. All filters are combined with AND, matching the issue's
 * "Combine filters with AND logic" requirement.
 */
export function buildTipWhere(
  base: Prisma.TipWhereInput,
  filters: TipFilterInput = {}
): Prisma.TipWhereInput {
  // The generated Prisma filter types carry a model type parameter that makes
  // composing them progressively awkward; the shape is still validated by the
  // `Prisma.TipWhereInput` return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { ...base };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.minDate || filters.maxDate) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (filters.minDate) createdAt.gte = new Date(filters.minDate);
    if (filters.maxDate) createdAt.lte = new Date(filters.maxDate);
    where.createdAt = createdAt;
  }

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    const amount: { gte?: number; lte?: number } = {};
    if (filters.minAmount !== undefined) amount.gte = filters.minAmount;
    if (filters.maxAmount !== undefined) amount.lte = filters.maxAmount;
    where.amount = amount;
  }

  if (filters.fromUserId) {
    where.fromUserId = filters.fromUserId;
  }

  if (filters.creatorId) {
    where.creatorId = filters.creatorId;
  }

  const query = filters.query?.trim();
  if (query) {
    // Message is the field users mean by "search"; id / transactionHash are
    // included so a pasted id or tx hash resolves too. `mode: insensitive`
    // keeps the search case-insensitive on Postgres.
    const existing = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [
      ...existing,
      {
        OR: [
          { message: { contains: query, mode: 'insensitive' } },
          { id: { equals: query } },
          { transactionHash: { equals: query } },
        ],
      },
    ];
  }

  return where;
}

/**
 * The filters that were actually applied, echoed back with the result so
 * clients can build "showing results for …" UI and page correctly.
 */
export function describeTipFilters(filters: TipFilterInput = {}): Record<string, unknown> {
  const applied: Record<string, unknown> = {};
  if (filters.status) applied.status = filters.status;
  if (filters.minDate) applied.minDate = filters.minDate;
  if (filters.maxDate) applied.maxDate = filters.maxDate;
  if (filters.minAmount !== undefined) applied.minAmount = filters.minAmount;
  if (filters.maxAmount !== undefined) applied.maxAmount = filters.maxAmount;
  if (filters.fromUserId) applied.fromUserId = filters.fromUserId;
  if (filters.creatorId) applied.creatorId = filters.creatorId;
  const query = filters.query?.trim();
  if (query) applied.query = query;
  return applied;
}
