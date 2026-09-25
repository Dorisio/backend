import {
  CursorPaginationParams,
  OffsetPaginationParams,
  CursorPaginatedResult,
  OffsetPaginatedResult,
  DEFAULT_PAGE_SIZE,
  sanitizePageSize,
  sanitizePageNumber,
  parseSortParameters,
  encodeCursor,
  decodeCursor,
  formatOffsetPaginatedResult,
  formatCursorPaginatedResult,
  SortField,
} from '../utils/pagination';

export interface PrismaPaginationOptions {
  where?: Record<string, any>;
  include?: Record<string, any>;
  select?: Record<string, any>;
  allowedSortFields?: string[];
  defaultSortField?: string;
  defaultSortDirection?: 'asc' | 'desc';
}

/**
 * Executes an offset-paginated query using Prisma
 */
export async function paginateWithOffset<T>(
  modelDelegate: {
    findMany: (args: any) => Promise<T[]>;
    count: (args: any) => Promise<number>;
  },
  params: OffsetPaginationParams,
  options: PrismaPaginationOptions = {}
): Promise<OffsetPaginatedResult<T>> {
  const page = sanitizePageNumber(params.page);
  const pageSize = sanitizePageSize(params.pageSize, DEFAULT_PAGE_SIZE);

  const sortFields = parseSortParameters(
    params.sortBy,
    params.sortOrder,
    options.allowedSortFields || ['createdAt', 'id', 'updatedAt', 'amount', 'totalEarnings'],
    options.defaultSortField || 'createdAt',
    options.defaultSortDirection || 'desc'
  );

  const orderBy = sortFields.map((s) => ({ [s.field]: s.direction }));
  const skip = (page - 1) * pageSize;

  const [items, total] = await Promise.all([
    modelDelegate.findMany({
      where: options.where,
      include: options.include,
      select: options.select,
      skip,
      take: pageSize,
      orderBy,
    }),
    modelDelegate.count({
      where: options.where,
    }),
  ]);

  return formatOffsetPaginatedResult(items, total, page, pageSize);
}

/**
 * Executes a cursor-based (keyset) paginated query using Prisma
 */
export async function paginateWithCursor<T extends { id: string }>(
  modelDelegate: {
    findMany: (args: any) => Promise<T[]>;
    count?: (args: any) => Promise<number>;
  },
  params: CursorPaginationParams,
  options: PrismaPaginationOptions = {}
): Promise<CursorPaginatedResult<T>> {
  const limit = sanitizePageSize(params.first || params.limit, DEFAULT_PAGE_SIZE);
  const cursorString = params.after || params.cursor;

  const sortFields = parseSortParameters(
    params.sortBy,
    params.sortOrder,
    options.allowedSortFields || ['createdAt', 'id', 'updatedAt', 'amount', 'totalEarnings'],
    options.defaultSortField || 'createdAt',
    options.defaultSortDirection || 'desc'
  );

  const orderBy = sortFields.map((s) => ({ [s.field]: s.direction }));
  const where: Record<string, any> = { ...options.where };

  let cursorPrismaArg: Record<string, any> | undefined;
  let skip = 0;

  if (cursorString) {
    const decoded = decodeCursor(cursorString);
    cursorPrismaArg = { id: decoded.id };
    skip = 1; // skip the cursor record itself
  }

  // Fetch limit + 1 to determine if there is a next page
  const items = await modelDelegate.findMany({
    where,
    include: options.include,
    select: options.select,
    take: limit + 1,
    skip,
    cursor: cursorPrismaArg,
    orderBy,
  });

  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, limit) : items;

  let totalCount: number | undefined;
  if (modelDelegate.count) {
    totalCount = await modelDelegate.count({ where: options.where });
  }

  return formatCursorPaginatedResult(
    resultItems,
    limit,
    hasMore,
    Boolean(cursorString),
    totalCount,
    (item: any) => {
      const values: Record<string, any> = {};
      for (const s of sortFields) {
        if (s.field !== 'id') {
          values[s.field] = item[s.field];
        }
      }
      return values;
    }
  );
}

export * from '../utils/pagination';
