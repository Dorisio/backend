import type { PrismaClient } from '@prisma/client';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerWebhookRoutes } from './webhook.routes';
const { testWebhook } = vi.hoisted(() => ({ testWebhook: vi.fn() }));
vi.mock('./webhook.service', () => ({ WebhookService: vi.fn(() => ({ testWebhook })) }));
vi.mock('../../middleware/auth', () => ({ authMiddleware: async (request: FastifyRequest, reply: FastifyReply) => {
  if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' });
  request.user = { userId: 'user', email: 'user@example.com', role: 'creator' };
} }));
const app = Fastify();
const prisma = { creator: { findUnique: vi.fn().mockResolvedValue({ id: 'creator' }) } };
registerWebhookRoutes(app, prisma as unknown as PrismaClient);
afterEach(() => { vi.clearAllMocks(); });
it('requires authentication before testing a webhook', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/hook/test' });
  expect(response.statusCode).toBe(401);
  expect(testWebhook).not.toHaveBeenCalled();
});
it('queues an authenticated test using the current creator identity', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/hook/test', headers: { authorization: 'Bearer token' } });
  expect(response.statusCode).toBe(202);
  expect(testWebhook).toHaveBeenCalledWith('hook', 'creator');
});

