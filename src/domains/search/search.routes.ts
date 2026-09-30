import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { SearchService } from './search.service';
import { formatSuccess } from '../../types/response';
import { ValidationError } from '../../utils/errors';

const SearchQuerySchema = z.object({
  q: z.string().trim().max(200, 'Search query must be at most 200 characters').optional(),
  category: z.string().trim().max(50).optional(),
  tag: z.string().trim().max(50).optional(),
  verified: z.enum(['true', 'false']).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

const AutocompleteQuerySchema = z.object({
  q: z.string().trim().min(1, 'q is required for autocomplete').max(100),
});

const TrendingQuerySchema = z.object({
  limit: z.string().optional(),
});

function toValidationError(error: z.ZodError): ValidationError {
  return new ValidationError('Invalid search parameters', {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

export function registerSearchRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const searchService = new SearchService(prisma);

  // GET /api/v1/search - full-text creator search with facets and pagination
  app.get(
    '/api/v1/search',
    {
      schema: {
        description: 'Full-text creator search with facets and ranking',
        tags: ['search'],
      },
    },
    async (request, reply) => {
      const parsed = SearchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw toValidationError(parsed.error);
      }

      const { q, category, tag, verified, page, pageSize } = parsed.data;
      const result = await searchService.search({
        q,
        category,
        tag,
        verified: verified === undefined ? undefined : verified === 'true',
        page,
        pageSize,
      });

      return reply.send(formatSuccess(result));
    }
  );

  // GET /api/v1/search/autocomplete - prefix suggestions from creators + popular terms
  app.get(
    '/api/v1/search/autocomplete',
    {
      schema: {
        description: 'Autocomplete suggestions for creators and popular search terms',
        tags: ['search'],
      },
    },
    async (request, reply) => {
      const parsed = AutocompleteQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw toValidationError(parsed.error);
      }

      const result = await searchService.autocomplete(parsed.data.q);
      return reply.send(formatSuccess(result));
    }
  );

  // GET /api/v1/search/trending - most frequent search terms (analytics)
  app.get(
    '/api/v1/search/trending',
    {
      schema: {
        description: 'Most frequent search terms',
        tags: ['search'],
      },
    },
    async (request, reply) => {
      const parsed = TrendingQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw toValidationError(parsed.error);
      }

      const limit = parsed.data.limit ? parseInt(parsed.data.limit, 10) : 10;
      if (Number.isNaN(limit) || limit < 1 || limit > 50) {
        throw new ValidationError('limit must be an integer between 1 and 50');
      }

      const items = await searchService.getTrendingSearches(limit);
      return reply.send(formatSuccess({ items }));
    }
  );
}
