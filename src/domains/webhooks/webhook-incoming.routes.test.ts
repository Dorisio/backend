import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWebhookSignatureHeaders } from '../../lib/webhooks/creator-webhook-verification';
import { registerIncomingWebhookRoutes } from './webhook-incoming.routes';

const { auditRecord, logger } = vi.hoisted(() => ({
  auditRecord: vi.fn().mockResolvedValue(undefined),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../services/audit.service', () => ({
  AuditService: vi.fn(() => ({ record: auditRecord })),
}));
vi.mock('../../utils/logger', () => ({ logger }));

const webhookId = 'webhook-1';
const secret = 'webhook-secret';
const timestamp = Math.floor(Date.now() / 1000);
const rawBody = JSON.stringify({ event_type: 'tip.created', tipId: 'tip-1' });

let app: ReturnType<typeof Fastify>;
let prisma: {
  webhook: { findUnique: ReturnType<typeof vi.fn> };
  webhookEvent: { create: ReturnType<typeof vi.fn> };
  webhookNonce: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

describe('incoming webhook signature verification', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    prisma = {
      webhook: {
        findUnique: vi.fn().mockResolvedValue({
          id: webhookId,
          secret,
          previousSecret: null,
          secretRotatedAt: null,
        }),
      },
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      webhookNonce: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    registerIncomingWebhookRoutes(app, prisma as unknown as PrismaClient);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid signature over timestamp, nonce, and raw body', async () => {
    const headers = buildWebhookSignatureHeaders(rawBody, secret, timestamp, 'nonce-1');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/incoming/${webhookId}`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.webhookNonce.create).toHaveBeenCalledOnce();
    expect(prisma.webhookEvent.create).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'invalid-signature'],
  ])('rejects a %s signature without processing the event', async (_kind, signature) => {
    const headers = buildWebhookSignatureHeaders(rawBody, secret, timestamp, `nonce-${_kind}`);
    if (signature === undefined) {
      delete headers['X-Webhook-Signature'];
    } else {
      headers['X-Webhook-Signature'] = signature;
    }

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/incoming/${webhookId}`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
