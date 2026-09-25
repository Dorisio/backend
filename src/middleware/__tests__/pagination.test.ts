import { describe, it, expect } from 'vitest';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  extractPaginationParams,
  paginationMiddleware,
  OffsetPaginationQuerySchema,
  CursorPaginationQuerySchema,
} from '../pagination';
import { ValidationError } from '../../utils/errors';
import { encodeCursor } from '../../utils/pagination';

describe('Pagination Middleware & Query Validation', () => {
  describe('OffsetPaginationQuerySchema', () => {
    it('should parse defaults when empty', () => {
      const parsed = OffsetPaginationQuerySchema.parse({});
      expect(parsed.page).toBe(1);
      expect(parsed.pageSize).toBe(20);
    });

    it('should parse valid page and pageSize', () => {
      const parsed = OffsetPaginationQuerySchema.parse({ page: '3', pageSize: '50' });
      expect(parsed.page).toBe(3);
      expect(parsed.pageSize).toBe(50);
    });

    it('should reject invalid page or pageSize', () => {
      expect(() => OffsetPaginationQuerySchema.parse({ page: '0' })).toThrow();
      expect(() => OffsetPaginationQuerySchema.parse({ page: '-1' })).toThrow();
      expect(() => OffsetPaginationQuerySchema.parse({ pageSize: '150' })).toThrow();
      expect(() => OffsetPaginationQuerySchema.parse({ pageSize: '0' })).toThrow();
    });
  });

  describe('CursorPaginationQuerySchema', () => {
    it('should parse defaults', () => {
      const parsed = CursorPaginationQuerySchema.parse({});
      expect(parsed.limit).toBe(20);
    });

    it('should parse cursor arguments', () => {
      const parsed = CursorPaginationQuerySchema.parse({ first: '10', after: 'curs_123' });
      expect(parsed.first).toBe(10);
      expect(parsed.after).toBe('curs_123');
    });
  });

  describe('extractPaginationParams', () => {
    it('should extract default offset parameters', () => {
      const result = extractPaginationParams({});
      expect(result.mode).toBe('offset');
      expect(result.offset.page).toBe(1);
      expect(result.offset.pageSize).toBe(20);
      expect(result.sortFields).toEqual([
        { field: 'createdAt', direction: 'desc' },
        { field: 'id', direction: 'desc' },
      ]);
    });

    it('should extract cursor mode when cursor or after is present', () => {
      const cursor = encodeCursor({ id: 'tip_99' });
      const result = extractPaginationParams({ after: cursor, limit: '25' });
      expect(result.mode).toBe('cursor');
      expect(result.cursor.limit).toBe(25);
      expect(result.cursor.after).toBe(cursor);
    });

    it('should reject negative pagination values', () => {
      expect(() => extractPaginationParams({ page: -1 })).toThrow(ValidationError);
      expect(() => extractPaginationParams({ pageSize: -5 })).toThrow(ValidationError);
      expect(() => extractPaginationParams({ limit: -10 })).toThrow(ValidationError);
    });

    it('should reject page size exceeding 100', () => {
      expect(() => extractPaginationParams({ pageSize: 101 })).toThrow(ValidationError);
      expect(() => extractPaginationParams({ limit: 200 })).toThrow(ValidationError);
    });

    it('should reject conflicting cursor parameters (first + last)', () => {
      expect(() => extractPaginationParams({ first: 10, last: 10 })).toThrow(ValidationError);
    });

    it('should reject conflicting cursor parameters (after + before)', () => {
      const c1 = encodeCursor({ id: '1' });
      const c2 = encodeCursor({ id: '2' });
      expect(() => extractPaginationParams({ after: c1, before: c2 })).toThrow(ValidationError);
    });

    it('should extract allowed filters', () => {
      const result = extractPaginationParams(
        { status: 'completed', creatorId: 'c_123', unallowed: 'hack' },
        { allowedFilterFields: ['status', 'creatorId'] }
      );
      expect(result.filters).toEqual({
        status: 'completed',
        creatorId: 'c_123',
      });
      expect(result.filters.unallowed).toBeUndefined();
    });
  });

  describe('paginationMiddleware hook', () => {
    it('should attach parsed pagination context to request', async () => {
      const middleware = paginationMiddleware({
        allowedSortFields: ['createdAt', 'amount', 'id'],
        allowedFilterFields: ['status'],
      });

      const req = {
        query: { page: '2', pageSize: '15', sortBy: 'amount', sortOrder: 'asc', status: 'pending' },
      } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await middleware(req, reply);

      expect(req.pagination).toBeDefined();
      expect(req.pagination?.offset.page).toBe(2);
      expect(req.pagination?.offset.pageSize).toBe(15);
      expect(req.pagination?.sortFields[0]).toEqual({ field: 'amount', direction: 'asc' });
      expect(req.pagination?.filters.status).toBe('pending');
    });

    it('should throw ValidationError on invalid query parameters', async () => {
      const middleware = paginationMiddleware();
      const req = { query: { page: '-5' } } as unknown as FastifyRequest;
      const reply = {} as FastifyReply;

      await expect(middleware(req, reply)).rejects.toThrow(ValidationError);
    });
  });
});
