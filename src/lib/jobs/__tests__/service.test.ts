import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryJobQueue } from '../memory-queue';
import { JobService, createJobService } from '../service';
import { DeadLetterManager } from '../dead-letter';
import { JobEventBus } from '../events';
import { CRON_PRESETS } from '../scheduler';
import { QUEUE_NAMES } from '../types';

describe('JobService', () => {
  let service: JobService;
  let queues: Map<string, InMemoryJobQueue>;
  let deadLetterQueue: InMemoryJobQueue;

  beforeEach(() => {
    queues = new Map();
    deadLetterQueue = new InMemoryJobQueue('jobs-dlq');
    service = createJobService({
      createQueue: (name) => {
        const queue = new InMemoryJobQueue(name);
        queues.set(name, queue);
        return queue;
      },
      deadLetterQueue,
      events: new JobEventBus(),
    });
  });

  it('lazily creates queues and enqueues jobs', async () => {
    const job = await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    expect(job.name).toBe('email.send');
    expect(queues.has(QUEUE_NAMES.EMAIL)).toBe(true);
  });

  it('emits an enqueued event', async () => {
    const events = new JobEventBus();
    const handler = vi.fn();
    events.on('enqueued', handler);

    const svc = createJobService({
      createQueue: (name) => new InMemoryJobQueue(name),
      deadLetterQueue,
      events,
    });

    await svc.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports job status', async () => {
    const job = await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    const status = await service.getStatus(QUEUE_NAMES.EMAIL, job.id);
    expect(status?.id).toBe(job.id);

    expect(await service.getStatus(QUEUE_NAMES.EMAIL, 'missing')).toBeNull();
  });

  it('cancels jobs that have not started', async () => {
    const job = await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    expect(await service.cancel(QUEUE_NAMES.EMAIL, job.id)).toBe(true);
    expect(await service.getStatus(QUEUE_NAMES.EMAIL, job.id)).toBeNull();
  });

  it('refuses to cancel jobs that are already running or finished', async () => {
    const queue = new InMemoryJobQueue(QUEUE_NAMES.EMAIL);
    queue.setProcessor('email.send', async () => 'done');
    const job = await queue.enqueue('email.send', { to: 'a@b.com' });
    await queue.processNext();

    const svc = createJobService({ queues: new Map([[QUEUE_NAMES.EMAIL, queue]]), deadLetterQueue });
    expect(await svc.cancel(QUEUE_NAMES.EMAIL, job.id)).toBe(false);
  });

  it('returns false when cancelling an unknown job', async () => {
    expect(await service.cancel(QUEUE_NAMES.EMAIL, 'nope')).toBe(false);
  });

  it('exposes queue depth', async () => {
    await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'b@c.com' });

    const depth = await service.getQueueDepth(QUEUE_NAMES.EMAIL);
    expect(depth.waiting).toBe(2);
  });

  it('schedules recurring jobs', async () => {
    const job = await service.schedule(
      QUEUE_NAMES.ANALYTICS,
      'analytics.aggregate',
      { windowStart: 'a', windowEnd: 'b' },
      { cron: CRON_PRESETS.analyticsRollup }
    );
    expect(job.name).toBe('analytics.aggregate');
  });

  describe('dead letters', () => {
    it('lists and replays dead lettered jobs', async () => {
      const manager = new DeadLetterManager(deadLetterQueue);
      await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });

      const stored = await manager.add({
        id: 'failed-1',
        name: 'email.send',
        queue: QUEUE_NAMES.EMAIL,
        data: { to: 'a@b.com' },
        state: 'failed',
        progress: 0,
        attemptsMade: 3,
        maxAttempts: 3,
        priority: 10,
      });

      const deadLetters = await service.getDeadLetterJobs();
      expect(deadLetters).toHaveLength(1);

      const replayed = await service.retryDeadLetter(stored.id, QUEUE_NAMES.EMAIL);
      expect(replayed).not.toBeNull();
      expect(await service.getDeadLetterJobs()).toHaveLength(0);
    });

    it('returns empty results when no dead letter queue is configured', async () => {
      const svc = createJobService({ createQueue: (name) => new InMemoryJobQueue(name) });
      expect(await svc.getDeadLetterJobs()).toEqual([]);
      expect(await svc.retryDeadLetter('x', 'email')).toBeNull();
      expect(await svc.purgeDeadLetters()).toBe(0);
    });
  });

  it('closes all queues', async () => {
    await service.enqueue(QUEUE_NAMES.EMAIL, 'email.send', { to: 'a@b.com' });
    await expect(service.closeAll()).resolves.toBeUndefined();
  });

  it('throws for unregistered queues when no factory is provided', () => {
    const svc = createJobService({});
    expect(() => svc.getQueue('nope')).toThrow();
  });
});
