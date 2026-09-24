import { ValidationError } from '../utils/errors';

export interface CursorPaginationParams {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  totalCount?: number;
}

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface CursorPaginatedResult<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  total?: number;
}

/**
 * Base64 URL-safe cursor serialization
 */
export function encodeCursor(data: unknown): string {
  const json = JSON.stringify(data);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Base64 URL-safe cursor deserialization
 */
export function decodeCursor<T = unknown>(cursor: string): T {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }
}

/**
 * Validates and normalizes cursor pagination parameters
 */
export function normalizePaginationParams(
  params: CursorPaginationParams,
  defaultLimit = 20,
  maxLimit = 100
): {
  limit: number;
  isForward: boolean;
  cursor?: string;
} {
  const { first, after, last, before } = params;

  if (first !== undefined && last !== undefined) {
    throw new ValidationError('Cannot specify both `first` and `last` pagination parameters');
  }

  if (after !== undefined && before !== undefined) {
    throw new ValidationError('Cannot specify both `after` and `before` pagination parameters');
  }

  let limit = defaultLimit;
  let isForward = true;
  let cursor: string | undefined;

  if (first !== undefined) {
    if (first < 1) throw new ValidationError('`first` must be greater than 0');
    if (first > maxLimit) throw new ValidationError(`\`first\` cannot exceed ${maxLimit}`);
    limit = first;
    isForward = true;
    cursor = after;
  } else if (last !== undefined) {
    if (last < 1) throw new ValidationError('`last` must be greater than 0');
    if (last > maxLimit) throw new ValidationError(`\`last\` cannot exceed ${maxLimit}`);
    limit = last;
    isForward = false;
    cursor = before;
  } else if (after !== undefined) {
    cursor = after;
    isForward = true;
  } else if (before !== undefined) {
    cursor = before;
    isForward = false;
  }

  return { limit, isForward, cursor };
}

/**
 * Construct a standard CursorPaginatedResult from items and pagination metadata
 */
export function buildCursorResult<T>(
  items: T[],
  limit: number,
  isForward: boolean,
  hasCursor: boolean,
  getCursor: (item: T) => unknown,
  totalCount?: number
): CursorPaginatedResult<T> {
  const hasMore = items.length > limit;
  const nodes = hasMore ? (isForward ? items.slice(0, limit) : items.slice(1)) : items;

  const edges: Edge<T>[] = nodes.map((node) => ({
    node,
    cursor: encodeCursor(getCursor(node)),
  }));

  const startCursor = edges.length > 0 ? edges[0].cursor : null;
  const endCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;

  return {
    edges,
    pageInfo: {
      hasNextPage: isForward ? hasMore : hasCursor,
      hasPreviousPage: isForward ? hasCursor : hasMore,
      startCursor,
      endCursor,
      totalCount,
    },
    total: totalCount,
  };
}

/**
 * In-memory cursor pagination utility for arrays
 */
export function paginateArray<T>(
  array: T[],
  params: CursorPaginationParams,
  getCursor: (item: T) => unknown
): CursorPaginatedResult<T> {
  const { limit, isForward, cursor } = normalizePaginationParams(params);

  let startIndex = 0;
  let endIndex = array.length;

  if (cursor) {
    const decodedCursor = decodeCursor(cursor);
    const targetCursorJson = JSON.stringify(decodedCursor);

    const cursorIdx = array.findIndex(
      (item) => JSON.stringify(getCursor(item)) === targetCursorJson
    );

    if (cursorIdx !== -1) {
      if (isForward) {
        startIndex = cursorIdx + 1;
      } else {
        endIndex = cursorIdx;
      }
    }
  }

  const slice = array.slice(startIndex, endIndex);
  const items = isForward
    ? slice.slice(0, limit + 1)
    : slice.slice(Math.max(0, slice.length - (limit + 1)));

  return buildCursorResult(
    items,
    limit,
    isForward,
    Boolean(cursor),
    getCursor,
    array.length
  );
}
