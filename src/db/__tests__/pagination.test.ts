import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  normalizePaginationParams,
  buildCursorResult,
  paginateArray,
} from '../pagination';
import { ValidationError } from '../../utils/errors';

describe('Cursor-Based Keyset Pagination', () => {
  describe('encodeCursor & decodeCursor', () => {
    it('should encode and decode arbitrary cursor objects', () => {
      const data = { id: 'tip_123', createdAt: '2026-09-24T00:00:00.000Z' };
      const cursor = encodeCursor(data);
      expect(typeof cursor).toBe('string');
      expect(cursor).not.toContain(' ');

      const decoded = decodeCursor<typeof data>(cursor);
      expect(decoded).toEqual(data);
    });

    it('should throw ValidationError on invalid cursor strings', () => {
      expect(() => decodeCursor('invalid!not!base64url')).toThrow(ValidationError);
    });
  });

  describe('normalizePaginationParams', () => {
    it('should default to first=20 if no params provided', () => {
      const normalized = normalizePaginationParams({});
      expect(normalized.limit).toBe(20);
      expect(normalized.isForward).toBe(true);
      expect(normalized.cursor).toBeUndefined();
    });

    it('should handle forward pagination with first and after', () => {
      const normalized = normalizePaginationParams({ first: 10, after: 'cur_123' });
      expect(normalized.limit).toBe(10);
      expect(normalized.isForward).toBe(true);
      expect(normalized.cursor).toBe('cur_123');
    });

    it('should handle backward pagination with last and before', () => {
      const normalized = normalizePaginationParams({ last: 15, before: 'cur_456' });
      expect(normalized.limit).toBe(15);
      expect(normalized.isForward).toBe(false);
      expect(normalized.cursor).toBe('cur_456');
    });

    it('should reject invalid combinations', () => {
      expect(() => normalizePaginationParams({ first: 10, last: 10 })).toThrow(ValidationError);
      expect(() => normalizePaginationParams({ after: 'a', before: 'b' })).toThrow(ValidationError);
      expect(() => normalizePaginationParams({ first: 0 })).toThrow(ValidationError);
      expect(() => normalizePaginationParams({ first: 150 })).toThrow(ValidationError);
    });
  });

  describe('paginateArray', () => {
    const sampleItems = Array.from({ length: 50 }, (_, i) => ({
      id: `item_${i + 1}`,
      val: i + 1,
    }));

    it('should paginate first page correctly', () => {
      const result = paginateArray(sampleItems, { first: 5 }, (item) => ({ id: item.id }));

      expect(result.edges).toHaveLength(5);
      expect(result.edges[0].node.id).toBe('item_1');
      expect(result.edges[4].node.id).toBe('item_5');
      expect(result.pageInfo.hasNextPage).toBe(true);
      expect(result.pageInfo.hasPreviousPage).toBe(false);
      expect(result.pageInfo.startCursor).toBeDefined();
      expect(result.pageInfo.endCursor).toBeDefined();
      expect(result.total).toBe(50);
    });

    it('should paginate next page using after cursor', () => {
      const firstPage = paginateArray(sampleItems, { first: 5 }, (item) => ({ id: item.id }));
      const afterCursor = firstPage.pageInfo.endCursor!;

      const secondPage = paginateArray(
        sampleItems,
        { first: 5, after: afterCursor },
        (item) => ({ id: item.id })
      );

      expect(secondPage.edges).toHaveLength(5);
      expect(secondPage.edges[0].node.id).toBe('item_6');
      expect(secondPage.edges[4].node.id).toBe('item_10');
      expect(secondPage.pageInfo.hasPreviousPage).toBe(true);
      expect(secondPage.pageInfo.hasNextPage).toBe(true);
    });

    it('should handle last page correctly', () => {
      const lastPage = paginateArray(
        sampleItems,
        { first: 10, after: encodeCursor({ id: 'item_45' }) },
        (item) => ({ id: item.id })
      );

      expect(lastPage.edges).toHaveLength(5);
      expect(lastPage.edges[0].node.id).toBe('item_46');
      expect(lastPage.edges[4].node.id).toBe('item_50');
      expect(lastPage.pageInfo.hasNextPage).toBe(false);
    });
  });
});
