import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { CreatorService } from './creator.service';
import { CreateCreatorRequestSchema, UpdateCreatorRequestSchema } from './creator.types';
import { formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';

export const registerCreatorRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  const creatorService = new CreatorService(prisma);

  // GET /api/v1/creators - List creators with pagination
  app.get<{
    Querystring: {
      page?: string;
      pageSize?: string;
      limit?: string;
      search?: string;
      verifiedOnly?: string;
      sortBy?: string;
      sortOrder?: string;
    };
  }>(
    '/api/v1/creators',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, any>;
      const page = query.page ? parseInt(query.page) : 1;
      const pageSize = query.pageSize ? parseInt(query.pageSize) : query.limit ? parseInt(query.limit) : 20;

      const result = await creatorService.listCreators(page, pageSize, {
        search: query.search,
        verifiedOnly: query.verifiedOnly === 'true' || query.verifiedOnly === '1',
        sortBy: query.sortBy,
        sortOrder: query.sortOrder?.toLowerCase() as 'asc' | 'desc',
      });
      reply.send(formatSuccess(result));
    }
  );

  app.post<{ Body: any }>(
    '/api/v1/creators',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateCreatorRequestSchema.parse(request.body);
      const user = request.user;
      if (!user) {
        throw new Error('User not authenticated');
      }
      const result = await creatorService.createCreator(user.userId, body);
      reply.code(201).send(formatSuccess(result));
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/creators/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const creator = await creatorService.getCreatorById(id);
      reply.send(formatSuccess(creator));
    }
  );

  app.get<{ Params: { username: string } }>(
    '/api/v1/creators/handle/:username',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { username } = request.params as { username: string };
      const creator = await creatorService.getCreatorByUsername(username);

      if (!creator.isPublic) {
        throw new Error('Creator profile is not public');
      }

      reply.send(formatSuccess(creator));
    }
  );

  app.patch<{ Body: any; Params: { id: string } }>(
    '/api/v1/creators/:id',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = UpdateCreatorRequestSchema.parse(request.body);
      const user = request.user;
      if (!user) {
        throw new Error('User not authenticated');
      }

      const creator = await creatorService.getCreatorById(id);
      if (creator.userId !== user.userId) {
        throw new Error('Unauthorized');
      }

      const updated = await creatorService.updateCreator(id, body);
      reply.send(formatSuccess(updated));
    }
  );
};
