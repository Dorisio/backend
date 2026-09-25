import { ValidationError } from './errors';

export const DEFAULT_PAGE_SIZE = 20;
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 100;

export type SortDirection = 'asc' | 'desc';

export interface SortField {
  field: string;
  direction: SortDirection;
}

export interface OffsetPaginationParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: SortDirection;
}

export interface CursorPaginationParams {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
  limit?: number;
  cursor?: string;
  sortBy?: string;
  sortOrder?: SortDirection;
}

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  totalCount?: number;
}

export interface CursorPaginatedResult<T> {
  data: T[];
  items: T[];
  cursor: string | null;
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
  pageInfo: CursorPageInfo;
  total?: number;
}

export interface OffsetPaginatedResult<T> {
  data: T[];
  items: T[];
  pagination: PaginationMeta;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorPayload {
  id: string;
  values?: Record<string, string | number | boolean | null>;
  timestamp?: number;
}

/**
 * Encodes cursor payload to URL-safe base64 string
 */
export function encodeCursor(payload: CursorPayload): string {
  try {
    const jsonStr = JSON.stringify(payload);
    return Buffer.from(jsonStr, 'utf-8').toString('base64url');
  } catch {
    throw new ValidationError('Failed to encode pagination cursor');
  }
}

/**
 * Decodes URL-safe base64 cursor string to CursorPayload
 */
export function decodeCursor(cursorString: string): CursorPayload {
  if (!cursorString || typeof cursorString !== 'string') {
    throw new ValidationError('Invalid cursor string');
  }

  try {
    const decodedStr = Buffer.from(cursorString, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decodedStr);

    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      throw new ValidationError('Malformed pagination cursor');
    }

    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError('Invalid base64 pagination cursor');
  }
}

/**
 * Sanitizes and validates page size within bounds [MIN_PAGE_SIZE, MAX_PAGE_SIZE]
 */
export function sanitizePageSize(size?: number | string, defaultSize: number = DEFAULT_PAGE_SIZE): number {
  if (size === undefined || size === null || size === '') {
    return defaultSize;
  }

  const parsed = typeof size === 'number' ? size : parseInt(size, 10);
  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new ValidationError(`Page size must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`);
  }

  if (parsed < MIN_PAGE_SIZE) {
    throw new ValidationError(`Page size must be at least ${MIN_PAGE_SIZE}`);
  }

  if (parsed > MAX_PAGE_SIZE) {
    throw new ValidationError(`Page size cannot exceed ${MAX_PAGE_SIZE}`);
  }

  return parsed;
}

/**
 * Sanitizes and validates page number (min: 1)
 */
export function sanitizePageNumber(page?: number | string, defaultPage: number = 1): number {
  if (page === undefined || page === null || page === '') {
    return defaultPage;
  }

  const parsed = typeof page === 'number' ? page : parseInt(page, 10);
  if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError('Page number must be an integer greater than or equal to 1');
  }

  return parsed;
}

/**
 * Parses and validates sort parameters
 */
export function parseSortParameters(
  sortBy?: string,
  sortOrder?: string,
  allowedFields: string[] = ['createdAt', 'id', 'amount', 'totalEarnings', 'updatedAt'],
  defaultField: string = 'createdAt',
  defaultDirection: SortDirection = 'desc'
): SortField[] {
  const direction: SortDirection =
    sortOrder?.toLowerCase() === 'asc' ? 'asc' : sortOrder?.toLowerCase() === 'desc' ? 'desc' : defaultDirection;

  const sortFields: SortField[] = [];

  if (!sortBy) {
    sortFields.push({ field: defaultField, direction });
  } else {
    const fields = sortBy.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length === 0) {
      sortFields.push({ field: defaultField, direction });
    } else {
      for (const field of fields) {
        let fieldName = field;
        let fieldDir: SortDirection = direction;

        if (field.startsWith('-')) {
          fieldName = field.substring(1);
          fieldDir = 'desc';
        } else if (field.startsWith('+')) {
          fieldName = field.substring(1);
          fieldDir = 'asc';
        }

        if (!allowedFields.includes(fieldName)) {
          throw new ValidationError(`Invalid sort field: ${fieldName}. Allowed fields: ${allowedFields.join(', ')}`);
        }

        sortFields.push({ field: fieldName, direction: fieldDir });
      }
    }
  }

  // Ensure secondary sort by id for deterministic keyset pagination if id isn't already included
  if (!sortFields.some((s) => s.field === 'id') && allowedFields.includes('id')) {
    sortFields.push({ field: 'id', direction: sortFields[0].direction });
  }

  return sortFields;
}

/**
 * Constructs Offset Pagination Metadata
 */
export function createOffsetMeta(total: number, page: number, pageSize: number): PaginationMeta {
  const totalPages = Math.ceil(total / pageSize);
  return {
    total,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

/**
 * Formats an offset-paginated response
 */
export function formatOffsetPaginatedResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): OffsetPaginatedResult<T> {
  const meta = createOffsetMeta(total, page, pageSize);
  return {
    data: items,
    items,
    pagination: meta,
    total: meta.total,
    page: meta.page,
    pageSize: meta.pageSize,
    totalPages: meta.totalPages,
    hasNext: meta.hasNext,
    hasPrev: meta.hasPrev,
  };
}

/**
 * Formats a cursor-paginated response
 */
export function formatCursorPaginatedResult<T extends { id: string }>(
  items: T[],
  limit: number,
  hasMore: boolean,
  hasPrevious: boolean = false,
  totalCount?: number,
  cursorFieldValues?: (item: T) => Record<string, string | number | boolean | null>
): CursorPaginatedResult<T> {
  const startItem = items.length > 0 ? items[0] : null;
  const endItem = items.length > 0 ? items[items.length - 1] : null;

  const startCursor = startItem
    ? encodeCursor({
        id: startItem.id,
        values: cursorFieldValues ? cursorFieldValues(startItem) : undefined,
      })
    : null;

  const endCursor = endItem
    ? encodeCursor({
        id: endItem.id,
        values: cursorFieldValues ? cursorFieldValues(endItem) : undefined,
      })
    : null;

  const pageInfo: CursorPageInfo = {
    hasNextPage: hasMore,
    hasPreviousPage: hasPrevious,
    startCursor,
    endCursor,
    totalCount,
  };

  return {
    data: items,
    items,
    cursor: endCursor,
    nextCursor: hasMore ? endCursor : null,
    prevCursor: hasPrevious ? startCursor : null,
    hasMore,
    pageInfo,
    total: totalCount,
  };
}

/**
 * Performs in-memory offset pagination on an array of items with sorting and filtering
 */
export function paginateArrayWithOffset<T>(
  items: T[],
  options: {
    page?: number;
    pageSize?: number;
    sortFields?: SortField[];
    filter?: (item: T) => boolean;
  }
): OffsetPaginatedResult<T> {
  const page = sanitizePageNumber(options.page);
  const pageSize = sanitizePageSize(options.pageSize);

  let filtered = options.filter ? items.filter(options.filter) : [...items];

  if (options.sortFields && options.sortFields.length > 0) {
    filtered.sort((a, b) => {
      const recA = a as Record<string, unknown>;
      const recB = b as Record<string, unknown>;
      for (const { field, direction } of options.sortFields!) {
        const valA = recA[field];
        const valB = recB[field];

        if (valA === valB) continue;
        if (valA === undefined || valA === null) return direction === 'asc' ? -1 : 1;
        if (valB === undefined || valB === null) return direction === 'asc' ? 1 : -1;

        const comparison = (valA as number | string) < (valB as number | string) ? -1 : 1;
        return direction === 'asc' ? comparison : -comparison;
      }
      return 0;
    });
  }

  const total = filtered.length;
  const startIndex = (page - 1) * pageSize;
  const paginatedItems = filtered.slice(startIndex, startIndex + pageSize);

  return formatOffsetPaginatedResult(paginatedItems, total, page, pageSize);
}

/**
 * Performs in-memory cursor pagination on an array of items
 */
export function paginateArrayWithCursor<T extends { id: string }>(
  items: T[],
  options: {
    limit?: number;
    after?: string;
    before?: string;
    cursor?: string;
    sortFields?: SortField[];
    filter?: (item: T) => boolean;
    getValues?: (item: T) => Record<string, string | number | boolean | null>;
  }
): CursorPaginatedResult<T> {
  const limit = sanitizePageSize(options.limit);
  let list = options.filter ? items.filter(options.filter) : [...items];

  // Sort only if sortFields are provided
  if (options.sortFields && options.sortFields.length > 0) {
    list.sort((a, b) => {
      const recA = a as Record<string, unknown>;
      const recB = b as Record<string, unknown>;
      for (const { field, direction } of options.sortFields!) {
        let valA = recA[field];
        let valB = recB[field];

        if (valA instanceof Date) valA = valA.getTime();
        if (valB instanceof Date) valB = valB.getTime();

        if (valA === valB) continue;
        if (valA === undefined || valA === null) return direction === 'asc' ? -1 : 1;
        if (valB === undefined || valB === null) return direction === 'asc' ? 1 : -1;

        const comparison = (valA as number | string) < (valB as number | string) ? -1 : 1;
        return direction === 'asc' ? comparison : -comparison;
      }
      return 0;
    });
  }

  const cursorTarget = options.after || options.cursor;
  let startIndex = 0;
  let hasPrevious = false;

  if (cursorTarget) {
    const decoded = decodeCursor(cursorTarget);
    const index = list.findIndex((item) => item.id === decoded.id);
    if (index !== -1) {
      startIndex = index + 1;
      hasPrevious = startIndex > 0;
    }
  } else if (options.before) {
    const decoded = decodeCursor(options.before);
    const index = list.findIndex((item) => item.id === decoded.id);
    if (index !== -1) {
      const end = index;
      startIndex = Math.max(0, end - limit);
      const sliced = list.slice(startIndex, end);
      return formatCursorPaginatedResult(
        sliced,
        limit,
        end < list.length,
        startIndex > 0,
        list.length,
        options.getValues
      );
    }
  }

  const paginatedItems = list.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < list.length;

  return formatCursorPaginatedResult(
    paginatedItems,
    limit,
    hasMore,
    hasPrevious,
    list.length,
    options.getValues
  );
}
