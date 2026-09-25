import { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';
import depthLimit from 'graphql-depth-limit';
import type { PrismaClient } from '@prisma/client';
import { config } from '../config/env';
import { verifyToken } from '../utils/jwt';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { logger } from '../utils/logger';

function estimateComplexity(query: string): number {
  const fields = query.match(/\w+(?=\s*[({])/g) || [];
  return fields.length;
}

export async function registerGraphQL(app: FastifyInstance, prisma: PrismaClient): Promise<void> {
  if (!config.GRAPHQL_ENABLED) {
    logger.info('GraphQL disabled via GRAPHQL_ENABLED=false');
    return;
  }

  await app.register(mercurius, {
    schema: typeDefs,
    resolvers,
    graphiql: config.NODE_ENV !== 'production',
    path: '/graphql',
    context: (request) => {
      let user: { userId: string; email: string; role: string } | undefined;
      const auth = request.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        try {
          user = verifyToken(auth.slice(7));
        } catch {
          user = undefined;
        }
      }
      return { prisma, user };
    },
    validationRules: [depthLimit(config.GRAPHQL_MAX_DEPTH)],
    queryDepth: config.GRAPHQL_MAX_DEPTH,
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/graphql')) return;
    if (request.method !== 'POST') return;
    const body = request.body as { query?: string } | undefined;
    if (body?.query) {
      const complexity = estimateComplexity(body.query);
      if (complexity > config.GRAPHQL_MAX_COMPLEXITY) {
        return reply.code(400).send({
          errors: [
            {
              message: `Query complexity ${complexity} exceeds max ${config.GRAPHQL_MAX_COMPLEXITY}`,
            },
          ],
        });
      }
    }
  });

  logger.info(
    { depth: config.GRAPHQL_MAX_DEPTH, complexity: config.GRAPHQL_MAX_COMPLEXITY },
    'GraphQL endpoint registered at /graphql',
  );
}
