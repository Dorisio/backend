import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  sanitizePageSize,
  sanitizePageNumber,
  parseSortParameters,
  createOffsetMeta,
  formatOffsetPaginatedResult,
  paginateArrayWithOffset,
  paginateArrayWithCursor,
  DEFAULT_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../pagination';
import { ValidationError } from '../errors';

describe('Pagination Utilities', () => {
  describe('Page size & number sanitization', () => {
    it('should return default page size (20) when undefined or null', () => {
      expect(sanitizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
      expect(sanitizePageSize(null as unknown as string)).toBe(DEFAULT_PAGE_SIZE);
      expect(sanitizePageSize('')).toBe(DEFAULT_PAGE_SIZE);
    });

    it('should respect custom valid page size', () => {
      expect(sanitizePageSize(10)).toBe(10);
      expect(sanitizePageSize('50')).toBe(50);
      expect(sanitizePageSize(1)).toBe(MIN_PAGE_SIZE);
      expect(sanitizePageSize(100)).toBe(MAX_PAGE_SIZE);
    });

    it('should reject page size below min (1)', () => {
      expect(() => sanitizePageSize(0)).toThrow(ValidationError);
      expect(() => sanitizePageSize(-5)).toThrow(ValidationError);
      expect(() => sanitizePageSize('-10')).toThrow(ValidationError);
    });

    it('should reject page size exceeding max (100)', () => {
      expect(() => sanitizePageSize(101)).toThrow(ValidationError);
      expect(() => sanitizePageSize(500)).toThrow(ValidationError);
      expect(() => sanitizePageSize('150')).toThrow(ValidationError);
    });

    it('should reject non-integer page sizes', () => {
      expect(() => sanitizePageSize(12.5)).toThrow(ValidationError);
      expect(() => sanitizePageSize('abc')).toThrow(ValidationError);
    });

    it('should sanitize page number correctly', () => {
      expect(sanitizePageNumber(undefined)).toBe(1);
      expect(sanitizePageNumber(3)).toBe(3);
      expect(sanitizePageNumber('5')).toBe(5);
      expect(() => sanitizePageNumber(0)).toThrow(ValidationError);
      expect(() => sanitizePageNumber(-2)).toThrow(ValidationError);
      expect(() => sanitizePageNumber('xyz')).toThrow(ValidationError);
    });
  });

  describe('Cursor Encoding & Decoding', () => {
    it('should encode and decode a composite cursor accurately', () => {
      const payload = {
        id: 'tip_123',
        values: { createdAt: 1718000000, amount: 25.5 },
      };

      const encoded = encodeCursor(payload);
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = decodeCursor(encoded);
      expect(decoded.id).toBe('tip_123');
      expect(decoded.values).toEqual({ createdAt: 1718000000, amount: 25.5 });
    });

    it('should reject invalid or malformed base64 cursor strings', () => {
      expect(() => decodeCursor('invalid-base64-!@#$')).toThrow(ValidationError);
      expect(() => decodeCursor('')).toThrow(ValidationError);
      // Valid base64 but invalid JSON structure
      const invalidJsonBase64 = Buffer.from('not-a-json').toString('base64url');
      expect(() => decodeCursor(invalidJsonBase64)).toThrow(ValidationError);
      // Valid json without id
      const noIdBase64 = Buffer.from(JSON.stringify({ someField: 123 })).toString('base64url');
      expect(() => decodeCursor(noIdBase64)).toThrow(ValidationError);
    });
  });

  describe('Sort Parameters Parsing', () => {
    it('should parse default sorting', () => {
      const sort = parseSortParameters();
      expect(sort).toEqual([
        { field: 'createdAt', direction: 'desc' },
        { field: 'id', direction: 'desc' },
      ]);
    });

    it('should parse single column sort with asc/desc', () => {
      const sortAsc = parseSortParameters('amount', 'asc');
      expect(sortAsc).toEqual([
        { field: 'amount', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]);

      const sortDesc = parseSortParameters('amount', 'desc');
      expect(sortDesc).toEqual([
        { field: 'amount', direction: 'desc' },
        { field: 'id', direction: 'desc' },
      ]);
    });

    it('should parse multi-column sorting with prefix notation (+ / -)', () => {
      const sort = parseSortParameters('-amount,+createdAt');
      expect(sort).toEqual([
        { field: 'amount', direction: 'desc' },
        { field: 'createdAt', direction: 'asc' },
        { field: 'id', direction: 'desc' },
      ]);
    });

    it('should reject invalid sort fields not in allowed list', () => {
      expect(() => parseSortParameters('sql_injection;DROP TABLE', 'asc')).toThrow(ValidationError);
      expect(() => parseSortParameters('unknownField', 'asc')).toThrow(ValidationError);
    });
  });

  describe('Offset Metadata & Formatting', () => {
    it('should create accurate offset metadata', () => {
      const meta = createOffsetMeta(45, 2, 20);
      expect(meta).toEqual({
        total: 45,
        page: 2,
        pageSize: 20,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });

      const firstPage = createOffsetMeta(45, 1, 20);
      expect(firstPage.hasPrev).toBe(false);
      expect(firstPage.hasNext).toBe(true);

      const lastPage = createOffsetMeta(45, 3, 20);
      expect(lastPage.hasPrev).toBe(true);
      expect(lastPage.hasNext).toBe(false);
    });

    it('should handle empty result metadata', () => {
      const emptyMeta = createOffsetMeta(0, 1, 20);
      expect(emptyMeta).toEqual({
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('should format offset paginated result with items and pagination object', () => {
      const items = [{ id: '1' }, { id: '2' }];
      const result = formatOffsetPaginatedResult(items, 50, 1, 20);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(50);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });
  });

  describe('Array Offset Pagination', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      id: `item_${i + 1}`,
      amount: (i + 1) * 10,
      createdAt: new Date(2026, 0, i + 1),
    }));

    it('should paginate default 20 items per page', () => {
      const result = paginateArrayWithOffset(data, {});
      expect(result.items).toHaveLength(20);
      expect(result.items[0].id).toBe('item_1');
      expect(result.total).toBe(50);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    it('should paginate custom page size and page number', () => {
      const result = paginateArrayWithOffset(data, { page: 2, pageSize: 15 });
      expect(result.items).toHaveLength(15);
      expect(result.items[0].id).toBe('item_16');
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(15);
      expect(result.totalPages).toBe(4);
    });

    it('should support sorting in offset pagination', () => {
      const result = paginateArrayWithOffset(data, {
        page: 1,
        pageSize: 5,
        sortFields: [{ field: 'amount', direction: 'desc' }],
      });
      expect(result.items[0].amount).toBe(500);
      expect(result.items[4].amount).toBe(460);
    });

    it('should support filtering combined with offset pagination', () => {
      const result = paginateArrayWithOffset(data, {
        page: 1,
        pageSize: 10,
        filter: (item) => item.amount >= 300,
      });
      expect(result.total).toBe(21); // items 30 to 50
      expect(result.items).toHaveLength(10);
      expect(result.items[0].amount).toBe(300);
    });
  });

  describe('Array Cursor / Keyset Pagination', () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      id: `item_${i + 1}`,
      amount: (i + 1) * 10,
      createdAt: new Date(2026, 0, i + 1),
    }));

    it('should paginate first page with cursor', () => {
      const result = paginateArrayWithCursor(data, { limit: 10 });
      expect(result.items).toHaveLength(10);
      expect(result.items[0].id).toBe('item_1');
      expect(result.hasMore).toBe(true);
      expect(result.pageInfo.hasNextPage).toBe(true);
      expect(result.pageInfo.hasPreviousPage).toBe(false);
      expect(result.nextCursor).toBeDefined();
    });

    it('should navigate forward using after cursor', () => {
      const firstPage = paginateArrayWithCursor(data, { limit: 10 });
      const nextCursor = firstPage.nextCursor!;

      const secondPage = paginateArrayWithCursor(data, {
        limit: 10,
        after: nextCursor,
      });

      expect(secondPage.items).toHaveLength(10);
      expect(secondPage.items[0].id).toBe('item_11');
      expect(secondPage.hasMore).toBe(true);
      expect(secondPage.pageInfo.hasPreviousPage).toBe(true);

      const thirdPage = paginateArrayWithCursor(data, {
        limit: 10,
        after: secondPage.nextCursor!,
      });

      expect(thirdPage.items).toHaveLength(5);
      expect(thirdPage.items[0].id).toBe('item_21');
      expect(thirdPage.hasMore).toBe(false);
      expect(thirdPage.nextCursor).toBeNull();
    });

    it('should handle edge case of empty list', () => {
      const result = paginateArrayWithCursor([], { limit: 20 });
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.pageInfo.startCursor).toBeNull();
      expect(result.pageInfo.endCursor).toBeNull();
    });

    it('should handle edge case of single item', () => {
      const result = paginateArrayWithCursor([{ id: 'single_1' }], { limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.pageInfo.startCursor).toBeDefined();
      expect(result.pageInfo.endCursor).toBeDefined();
      expect(result.pageInfo.startCursor).toBe(result.pageInfo.endCursor);
    });
  });
});
