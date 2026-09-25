import { describe, it, expect, vi } from 'vitest';
import { InMemoryJobQueue } from '../memory-queue';

describe('InMemoryJobQueue', () => {
  it('enqueues jobs with resolved priority', async () => {
    const queue = new InMemoryJobQueue('test');
    const job = await queue.enqueue('t', { a: 1 }, { priority: 'high' });
    expect(job.priority).toBe(5);
    expect(job.state).toBe('waiting');
    expect(await queue.getJob(job.id)).not.toBeNull();
  });

  it('is idempotent for a given jobId', async () => {
    const queue = new InMemoryJobQueue('test');
    const first = await queue.enqueue('t', { a: 1 }, { jobId: 'stable' });
    const second = await queue.enqueue('t', { a: 2 }, { jobId: 'stable' });

    expect(second.id).toBe(first.id);
    expect(second.data).toEqual({ a: 1 });
    expect(await queue.list()).toHaveLength(1);
  });

  it('processes the highest priority job first', async () => {
    const queue = new InMemoryJobQueue('test');
    const order: string[] = [];
    queue.setProcessor('low', async () => order.push('low'));
    queue.setProcessor('critical', async () => order.push('critical'));

    await queue.enqueue('low', {}, { priority: 'low' });
    await queue.enqueue('critical', {}, { priority: 'critical' });

    await queue.drain();
    expect(order).toEqual(['critical', 'low']);
  });

  it('retries failures until attempts are exhausted', async () => {
    const queue = new InMemoryJobQueue('test');
    let calls = 0;
    queue.setProcessor('flaky', async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });

    const job = await queue.enqueue('flaky', {}, { attempts: 3 });
    await queue.drain();

    const stored = await queue.getJob(job.id);
    expect(stored?.state).toBe('completed');
    expect(stored?.attemptsMade).toBe(2);
    expect(stored?.result).toBe('ok');
  });

  it('marks jobs failed once retries are exhausted', async () => {
    const queue = new InMemoryJobQueue('test');
    queue.setProcessor('always-fails', async () => {
      throw new Error('permanent');
    });

    const job = await queue.enqueue('always-fails', {}, { attempts: 2 });
    await queue.drain();

    const stored = await queue.getJob(job.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.attemptsMade).toBe(2);
    expect(stored?.failedReason).toBe('permanent');
  });

  it('fails jobs with no registered processor', async () => {
    const queue = new InMemoryJobQueue('test');
    const job = await queue.enqueue('unknown', {}, { attempts: 1 });
    await queue.drain();

    const stored = await queue.getJob(job.id);
    expect(stored?.state).toBe('failed');
  });

  it('reports counts per state', async () => {
    const queue = new InMemoryJobQueue('test');
    await queue.enqueue('a', {});
    await queue.enqueue('b', {}, { delay: 1000 });

    const counts = await queue.getCounts();
    expect(counts.waiting).toBe(1);
    expect(counts.delayed).toBe(1);
  });

  it('removes jobs', async () => {
    const queue = new InMemoryJobQueue('test');
    const job = await queue.enqueue('a', {});
    await queue.remove(job.id);
    expect(await queue.getJob(job.id)).toBeNull();
  });

  it('processNext returns false when the queue is empty', async () => {
    const queue = new InMemoryJobQueue('test');
    expect(await queue.processNext()).toBe(false);
  });

  it('closes cleanly', async () => {
    const queue = new InMemoryJobQueue('test');
    const close = vi.fn();
    queue.setProcessor('a', async () => close());
    await queue.enqueue('a', {});
    await queue.drain();
    await expect(queue.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalled();
  });
});
