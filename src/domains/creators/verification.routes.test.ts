import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

const state = vi.hoisted(() => ({
  role: 'creator',
  auth: vi.fn(),
  submitRequest: vi.fn().mockResolvedValue({ id: 'request-1', status: 'submitted' }),
  getRequestHistory: vi.fn().mockResolvedValue([]),
  getPendingRequests: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  decideRequest: vi.fn().mockResolvedValue({ id: 'request-1', status: 'approved' }),
  unverifyCreator: vi.fn().mockResolvedValue({ verified: false }),
  getVerificationDocument: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({ authMiddleware: state.auth }));
vi.mock('./verification.service', () => ({
  VerificationService: vi.fn().mockImplementation(() => ({
    submitRequest: state.submitRequest,
    getRequestHistory: state.getRequestHistory,
    getPendingRequests: state.getPendingRequests,
    decideRequest: state.decideRequest,
    unverifyCreator: state.unverifyCreator,
    getVerificationDocument: state.getVerificationDocument,
  })),
}));

import { registerVerificationRoutes } from './verification.routes';

describe('creator verification routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    state.role = 'creator';
    state.auth.mockImplementation(async (request: { user?: unknown }) => {
      request.user = { userId: 'user-1', email: 'creator@example.com', role: state.role };
    });
    app = Fastify({ logger: false });
    registerVerificationRoutes(app, {} as PrismaClient);
  });

  afterEach(async () => app.close());

  it('accepts an authenticated creator request and decodes uploaded evidence', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/verification-requests',
      payload: {
        statement: 'Creator identity request',
        documents: [{ filename: 'identity.png', contentType: 'image/png', data: Buffer.from('id').toString('base64') }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(state.submitRequest).toHaveBeenCalledWith('user-1', expect.objectContaining({
      documents: [expect.objectContaining({ filename: 'identity.png', data: Buffer.from('id') })],
    }));
  });

  it('restricts the admin queue and decisions to admins', async () => {
    state.role = 'admin';
    const queue = await app.inject({ method: 'GET', url: '/api/v1/admin/creator-verification/requests' });
    const approval = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/creator-verification/requests/request-1/approve',
      payload: {},
    });
    expect(queue.statusCode).toBe(200);
    expect(approval.statusCode).toBe(200);

    state.role = 'fan';
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/admin/creator-verification/requests' });
    expect(forbidden.statusCode).not.toBe(200);
    expect(state.getPendingRequests).toHaveBeenCalledTimes(1);
  });

  it('does not allow regular fans to submit verification requests', async () => {
    state.role = 'fan';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/creators/verification-requests',
      payload: {
        documents: [{ filename: 'identity.png', contentType: 'image/png', data: Buffer.from('id').toString('base64') }],
      },
    });
    expect(response.statusCode).not.toBe(201);
    expect(state.submitRequest).not.toHaveBeenCalled();
  });
});