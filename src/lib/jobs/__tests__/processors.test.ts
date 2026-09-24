import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../circuit-breaker';
import {
  createAnalyticsProcessor,
  createEmailProcessor,
  createImageProcessor,
  createProcessors,
  createStellarConfirmationProcessor,
} from '../processors';

describe('email processor', () => {
  it('delivers a valid message through the injected transport', async () => {
    const transport = vi.fn().mockResolvedValue({ providerId: 'msg-1' });
    const processor = createEmailProcessor({
      emailTransport: transport,
      emailBreaker: new CircuitBreaker({ name: 'email-test' }),
    });

    const result = await processor({ to: 'a@b.com', subject: 'Hi', body: 'Hello' });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: true, providerId: 'msg-1' });
  });

  it('rejects malformed messages', async () => {
    const processor = createEmailProcessor({ emailTransport: vi.fn() });
    await expect(processor({ to: '', subject: '' })).rejects.toThrow(/requires/);
  });

  it('opens the circuit breaker when the provider keeps failing', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('smtp down'));
    const breaker = new CircuitBreaker({ name: 'email-breaker', failureThreshold: 1 });
    const processor = createEmailProcessor({ emailTransport: transport, emailBreaker: breaker });

    await expect(processor({ to: 'a@b.com', subject: 'Hi' })).rejects.toThrow('smtp down');
    expect(breaker.getState()).toBe('OPEN');

    await expect(processor({ to: 'a@b.com', subject: 'Hi' })).rejects.toBeInstanceOf(
      CircuitBreakerOpenError
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('image processor', () => {
  it('rejects jobs without a source url', async () => {
    const processor = createImageProcessor();
    await expect(processor({})).rejects.toThrow(/sourceUrl/);
  });

  it('returns processing metadata and uses the fetcher when provided', async () => {
    const imageFetcher = vi.fn().mockResolvedValue(Buffer.from('bytes'));
    const processor = createImageProcessor({ imageFetcher });

    const result = await processor({ sourceUrl: 'https://cdn/x.png', width: 100, format: 'webp' });

    expect(imageFetcher).toHaveBeenCalledWith('https://cdn/x.png');
    expect(result).toMatchObject({
      processed: true,
      format: 'webp',
      dimensions: { width: 100, height: null },
      hasSourceBytes: true,
    });
  });
});

describe('analytics processor', () => {
  it('requires a time window', async () => {
    const processor = createAnalyticsProcessor();
    await expect(processor({})).rejects.toThrow(/windowStart/);
  });

  it('requires a database connection', async () => {
    const processor = createAnalyticsProcessor();
    await expect(
      processor({ windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-02T00:00:00.000Z' })
    ).rejects.toThrow(/database/);
  });

  it('aggregates completed tips for the window', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: 150 }, _count: { _all: 3 } });
    const processor = createAnalyticsProcessor({ prisma: { tip: { aggregate } } as never });

    const result = await processor({
      creatorId: 'creator-1',
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-02T00:00:00.000Z',
    });

    expect(result).toMatchObject({ totalAmount: 150, tipCount: 3, creatorId: 'creator-1' });
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'completed', creatorId: 'creator-1' }),
      })
    );
  });
});

describe('stellar confirmation processor', () => {
  it('requires a tip id and hash', async () => {
    const processor = createStellarConfirmationProcessor();
    await expect(processor({})).rejects.toThrow(/tipId/);
  });

  it('marks the tip completed', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'tip-1' });
    const processor = createStellarConfirmationProcessor({ prisma: { tip: { update } } as never });

    const result = await processor({ tipId: 'tip-1', transactionHash: 'abc' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'tip-1' },
      data: { status: 'completed' },
    });
    expect(result).toMatchObject({ confirmed: true, tipId: 'tip-1' });
  });
});

describe('createProcessors', () => {
  it('registers every supported job name', () => {
    const processors = createProcessors();
    expect(Object.keys(processors).sort()).toEqual(
      ['analytics.aggregate', 'email.send', 'image.process', 'stellar.confirm-transaction'].sort()
    );
    for (const processor of Object.values(processors)) {
      expect(typeof processor).toBe('function');
    }
  });
});
