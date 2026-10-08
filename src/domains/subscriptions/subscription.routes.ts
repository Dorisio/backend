import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as svc from './subscription.service';
import { prisma } from '../../lib/prisma'; // CHANGE #1 again

// CHANGE #3: import the same auth middleware the admin routes use, e.g.
// import { authMiddleware } from '../../middleware/auth';
import { authMiddleware } from '../../middleware/auth';

function userId(request: FastifyRequest): string {
  // CHANGE #3: make sure this matches where your auth stores the user
  return (request as any).user.id as string;
}

function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof svc.SubscriptionError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  throw err;
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/', async (request, reply) => {
    try {
      const sub = await svc.createSubscription(
        userId(request),
        request.body as svc.CreateInput,
      );
      return reply.status(201).send(sub);
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/', async (request) => svc.listSubscriptions(userId(request)));

  // Must be registered before "/:id" so "dashboard" is not read as an id
  app.get('/dashboard', async (request, reply) => {
    // CHANGE: adjust if the creator lookup in your schema is different
    const creator = await prisma.creator.findFirst({
      where: { userId: userId(request) },
    });
    if (!creator) return reply.status(403).send({ error: 'Creator account required' });
    return svc.getDashboard(creator.id);
  });

  app.get('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await svc.getSubscription(id, userId(request));
    } catch (e) {
      return handleError(e, reply);
    }
  });

  app.get('/:id/history', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return await svc.getHistory(id, userId(request));
    } catch (e) {
      return handleError(e, reply);
    }
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/:id/${action}`, async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const fn =
          action === 'pause'
            ? svc.pauseSubscription
            : action === 'resume'
              ? svc.resumeSubscription
              : svc.cancelSubscription;
        return await fn(id, userId(request));
      } catch (e) {
        return handleError(e, reply);
      }
    });
  }
}