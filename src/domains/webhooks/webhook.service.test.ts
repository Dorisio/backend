import type { WorkerOptions, JobsOptions } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookService } from './webhook.service';
import { verifyWebhookSignature } from './webhook.events';
import { resetCircuitBreakers } from '../../lib/circuit-breaker';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  dead: vi.fn(),
  post: vi.fn(),
  prisma: {
    webhook: { findUnique: vi.fn(), findMany: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn() },
  },
  process: undefined as
    | ((job: {
        id: string;
        data: unknown;
        opts: JobsOptions;
        attemptsMade: number;
      }) => Promise<unknown>)
    | undefined,
  options: undefined as WorkerOptions | undefined,
  failedHandler: undefined as ((job: any, error: Error) => Promise<void>) | undefined,
}));
vi.mock('../../lib/queue', () => ({
  webhookDispatchQueue: { add: mocks.add },
  bullConnection: {},
  backoffStrategy: vi.fn(),
  QUEUE_NAMES: {
    webhookDispatch: 'webhook-dispatch',
  },
  moveToDeadLetter: mocks.dead,
}));
vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mocks.prisma) }));
vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('bullmq', () => ({
  Worker: vi.fn((_name, process, options) => {
    mocks.process = process;
    mocks.options = options;

    return {
      on: vi.fn((event, handler) => {
        if (event === 'failed') {
          mocks.failedHandler = handler;
        }
      }),
    };
  }),
}));
import '../../lib/workers/webhook-dispatch.worker';

const subscriber = {
  id: 'hook',
  creatorId: 'creator',
  active: true,
  events: ['tip.created'],
  url: 'https://example.com/hook',
  secret: 'secret',
};
const service = new WebhookService(mocks.prisma as unknown as PrismaClient);
const publish = (n = 0) => service.dispatchEvent('creator', `tip-${n}`, 'tip.created', { n });
const job = (index = 0, attemptsMade = 0) => ({
  id: mocks.add.mock.calls[index][2].jobId,
  data: mocks.add.mock.calls[index][1],
  opts: mocks.add.mock.calls[index][2],
  attemptsMade,
  updateProgress: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  resetCircuitBreakers();
  vi.clearAllMocks();

  mocks.prisma.webhook.findMany.mockImplementation(async ({ where }) =>
    [subscriber].filter(
      (w) =>
        w.creatorId === where.creatorId &&
        w.active === where.active &&
        w.events.includes(where.events.has) &&
        (!where.id || where.id === w.id)
    )
  );
  mocks.prisma.webhook.findUnique.mockResolvedValue(subscriber);
  let id = 0;
  mocks.prisma.webhookEvent.create.mockImplementation(async ({ data }) => ({
    ...data,
    id: `delivery-${++id}`,
  }));
  mocks.prisma.webhookEvent.update.mockResolvedValue({});
  mocks.add.mockResolvedValue({});
  mocks.dead.mockResolvedValue({});
  mocks.post.mockReset().mockResolvedValue({ status: 200 });
});

describe('webhook delivery lifecycle', () => {
  it('persists pending records before enqueueing and passes the database eventId', async () => {
    mocks.add.mockImplementation(async (_name, data) => {
      expect(mocks.prisma.webhookEvent.create).toHaveBeenCalled();
      expect(data.eventId).toBe('delivery-1');
    });
    await publish();
    const stored = mocks.prisma.webhookEvent.create.mock.calls[0][0].data;
    expect(stored.status).toBe('pending');
    expect(JSON.parse(stored.payload)).toEqual(job().data.payload);
    expect(job().data.payload).toMatchObject({
      type: 'tip.created',
      version: '1',
      data: { transactionId: 'tip-0' },
    });
    expect(new Date(job().data.payload.createdAt).toISOString()).toBe(job().data.payload.createdAt);
  });
  it('preserves a pending record and enqueue error when Redis rejects a job', async () => {
    mocks.add.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(publish()).rejects.toThrow('Redis unavailable');
    expect(mocks.prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { lastError: 'Redis unavailable' },
    });
  });
  it('delivers the signed raw envelope to the subscriber and tracks success', async () => {
    await publish();
    await mocks.process(job());
    const [url, body, options] = mocks.post.mock.calls[0];
    expect(url).toBe(subscriber.url);
    expect(
      verifyWebhookSignature(body, subscriber.secret, options.headers['X-Dorisio-Signature'])
    ).toBe(true);
    expect(mocks.prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-1' },
        data: expect.objectContaining({ status: 'delivered', attempts: 1 }),
      })
    );
  });
  it('filters subscriptions, inactive hooks, and other creators before enqueueing', async () => {
    await service.dispatchEvent('creator', 'tip', 'payment.completed', {});
    await service.dispatchEvent('other', 'tip', 'tip.created', {});
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        creatorId: 'creator',
        active: true,
        events: { has: 'payment.completed' },
      },
      select: { id: true, url: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
  });
  it('uses five exponential attempts, retaining errors and dead-lettering only the last failure', async () => {
    await publish();
    expect(job().opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
    mocks.post.mockRejectedValue(new Error('HTTP 503'));
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentJob = job(0, attempt);

      await expect(mocks.process(currentJob)).rejects.toThrow('HTTP 503');

      expect(mocks.prisma.webhookEvent.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attempts: attempt + 1,
            status: 'pending',
            lastError: 'HTTP 503',
          }),
        })
      );

      if (attempt === 4) {
        const failedJob = job(0, 5);

        await mocks.failedHandler?.(failedJob, new Error('HTTP 503'));

        expect(mocks.prisma.webhookEvent.update).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              attempts: 5,
              status: 'failed',
              lastError: 'HTTP 503',
            }),
          })
        );

        expect(mocks.dead).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks.dead).not.toHaveBeenCalled();
      }
    }
    expect(mocks.dead).toHaveBeenCalledWith(
      'webhook-dispatch',
      'delivery-1',
      expect.objectContaining({
        eventId: 'delivery-1',
      }),
      'HTTP 503'
    );
  });
  it('tracks success after a retry without dead-lettering', async () => {
    await publish();
    mocks.post.mockRejectedValueOnce(new Error('timeout'));
    await expect(mocks.process(job())).rejects.toThrow();
    await mocks.process(job(0, 1));
    expect(mocks.prisma.webhookEvent.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'delivered', attempts: 2 }),
      })
    );
    expect(mocks.dead).not.toHaveBeenCalled();
  });
  it('keeps concurrent events and delivery IDs distinct', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, n) => publish(n)));
    expect(new Set(mocks.add.mock.calls.map((c) => c[1].eventId)).size).toBe(25);
    expect(new Set(mocks.add.mock.calls.map((c) => c[1].payload.id)).size).toBe(25);
    await Promise.all(mocks.add.mock.calls.map((_, n) => mocks.process(job(n))));
    expect(mocks.prisma.webhookEvent.update).toHaveBeenCalledTimes(25);
  });
  it('enqueues sequential publications in order and processes with concurrency one', async () => {
    await publish(1);
    await publish(2);
    expect(mocks.add.mock.calls.map((c) => c[1].payload.data.n)).toEqual([1, 2]);
    expect(mocks.options.concurrency).toBe(5);
    await mocks.process(job(0));
    await mocks.process(job(1));
    expect(mocks.post.mock.calls.map((c) => JSON.parse(c[1]).data.n)).toEqual([1, 2]);
  });
  it('allows a newer event to complete while an earlier event awaits retry', async () => {
    await publish(1);
    await publish(2);
    mocks.post.mockRejectedValueOnce(new Error('timeout'));
    await expect(mocks.process(job(0))).rejects.toThrow();
    await mocks.process(job(1));
    await mocks.process(job(0, 1));
    expect(mocks.post.mock.calls.map((c) => JSON.parse(c[1]).data.n)).toEqual([1, 2, 1]);
  });
  it('tests only the requested owned registered webhook', async () => {
    await service.testWebhook('hook', 'creator');
    expect(mocks.prisma.webhook.findMany).toHaveBeenCalledWith({
      where: {
        creatorId: 'creator',
        id: 'hook',
        active: true,
        events: { has: 'tip.created' },
      },
      select: { id: true, url: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    expect(job().data.payload.data.test).toBe(true);
    await expect(service.testWebhook('hook', 'other')).rejects.toThrow();
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });
});
