import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  OffsetPaginationParams,
  CursorPaginationParams,
  SortField,
  parseSortParameters,
  decodeCursor,
} from '../utils/pagination';
import { ValidationError } from '../utils/errors';

export const OffsetPaginationQuerySchema = z.object({
  page: z
    .preprocess((val) => (val !== undefined && val !== '' ? Number(val) : 1), z.number().int().min(1, 'Page must be at least 1'))
    .default(1),
  pageSize: z
    .preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : DEFAULT_PAGE_SIZE),
      z.number().int().min(MIN_PAGE_SIZE, `Page size must be at least ${MIN_PAGE_SIZE}`).max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
    )
    .default(DEFAULT_PAGE_SIZE),
  limit: z
    .preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
      z.number().int().min(MIN_PAGE_SIZE, `Limit must be at least ${MIN_PAGE_SIZE}`).max(MAX_PAGE_SIZE, `Limit cannot exceed ${MAX_PAGE_SIZE}`).optional()
    ),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
});

export const CursorPaginationQuerySchema = z.object({
  first: z
    .preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
      z.number().int().min(MIN_PAGE_SIZE, `First must be at least ${MIN_PAGE_SIZE}`).max(MAX_PAGE_SIZE, `First cannot exceed ${MAX_PAGE_SIZE}`).optional()
    ),
  limit: z
    .preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : DEFAULT_PAGE_SIZE),
      z.number().int().min(MIN_PAGE_SIZE, `Limit must be at least ${MIN_PAGE_SIZE}`).max(MAX_PAGE_SIZE, `Limit cannot exceed ${MAX_PAGE_SIZE}`)
    )
    .default(DEFAULT_PAGE_SIZE),
  after: z.string().optional(),
  cursor: z.string().optional(),
  last: z
    .preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
      z.number().int().min(MIN_PAGE_SIZE, `Last must be at least ${MIN_PAGE_SIZE}`).max(MAX_PAGE_SIZE, `Last cannot exceed ${MAX_PAGE_SIZE}`).optional()
    ),
  before: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
});

export interface ParsedPaginationContext {
  mode: 'offset' | 'cursor';
  offset: OffsetPaginationParams;
  cursor: CursorPaginationParams;
  sortFields: SortField[];
  filters: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    pagination?: ParsedPaginationContext;
  }
}

export interface PaginationOptions {
  allowedSortFields?: string[];
  defaultSortField?: string;
  defaultSortDirection?: 'asc' | 'desc';
  allowedFilterFields?: string[];
}

/**
 * Validates and extracts pagination parameters from a query object
 */
export function extractPaginationParams(
  query: unknown,
  options: PaginationOptions = {}
): ParsedPaginationContext {
  const allowedSort = options.allowedSortFields || ['createdAt', 'id', 'updatedAt', 'amount', 'totalEarnings'];
  const defaultSort = options.defaultSortField || 'createdAt';
  const defaultDir = options.defaultSortDirection || 'desc';

  const rawQuery = (query || {}) as Record<string, unknown>;

  // Check for both first and last in cursor pagination
  if (rawQuery.first && rawQuery.last) {
    throw new ValidationError('Cannot specify both first and last for cursor pagination');
  }

  // Check for both after and before in cursor pagination
  if (rawQuery.after && rawQuery.before) {
    throw new ValidationError('Cannot specify both after and before for cursor pagination');
  }

  // Validate cursor integrity if provided
  const cursorParam = (rawQuery.after || rawQuery.cursor || rawQuery.before) as string | undefined;
  if (cursorParam) {
    decodeCursor(cursorParam);
  }

  // Determine mode
  const isCursor = Boolean(rawQuery.cursor || rawQuery.after || rawQuery.before || rawQuery.first || rawQuery.last);

  // Validate offset / limit ranges
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;

  if (rawQuery.page !== undefined && rawQuery.page !== '') {
    const p = Number(rawQuery.page);
    if (isNaN(p) || !Number.isInteger(p) || p < 1) {
      throw new ValidationError('Page must be an integer greater than or equal to 1');
    }
    page = p;
  }

  const rawSize = rawQuery.pageSize ?? rawQuery.limit ?? rawQuery.first ?? rawQuery.last;
  if (rawSize !== undefined && rawSize !== '') {
    const s = Number(rawSize);
    if (isNaN(s) || !Number.isInteger(s) || s < MIN_PAGE_SIZE || s > MAX_PAGE_SIZE) {
      throw new ValidationError(`Page size / limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`);
    }
    pageSize = s;
  }

  const sortFields = parseSortParameters(
    rawQuery.sortBy as string | undefined,
    rawQuery.sortOrder as string | undefined,
    allowedSort,
    defaultSort,
    defaultDir
  );

  // Extract permitted filter fields
  const filters: Record<string, unknown> = {};
  if (options.allowedFilterFields) {
    for (const key of options.allowedFilterFields) {
      if (rawQuery[key] !== undefined && rawQuery[key] !== '') {
        filters[key] = rawQuery[key];
      }
    }
  }

  return {
    mode: isCursor ? 'cursor' : 'offset',
    offset: {
      page,
      pageSize,
      sortBy: rawQuery.sortBy as string | undefined,
      sortOrder: ((rawQuery.sortOrder as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    },
    cursor: {
      limit: pageSize,
      first: rawQuery.first ? Number(rawQuery.first) : undefined,
      last: rawQuery.last ? Number(rawQuery.last) : undefined,
      after: rawQuery.after as string | undefined,
      before: rawQuery.before as string | undefined,
      cursor: rawQuery.cursor as string | undefined,
      sortBy: rawQuery.sortBy as string | undefined,
      sortOrder: ((rawQuery.sortOrder as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
    },
    sortFields,
    filters,
  };
}

/**
 * Fastify preHandler middleware factory for standardizing pagination query handling
 */
export const paginationMiddleware =
  (options: PaginationOptions = {}) =>
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      request.pagination = extractPaginationParams(request.query, options);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new ValidationError(error.message);
      }
      throw new ValidationError('Invalid pagination parameters');
    }
  };
