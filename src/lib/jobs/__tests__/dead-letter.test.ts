import { describe, it, expect } from 'vitest';
import { DeadLetterManager, buildDeadLetterRecord, isExhausted, isDeadLetterQueueName } from '../dead-letter';
import { InMemoryJobQueue } from '../memory-queue';
import { JobRecord } from '../types';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    name: 'email.send',
    queue: 'email',
    data: { to: 'a@b.com' },
    state: 'failed',
    progress: 0,
    attemptsMade: 3,
    maxAttempts: 3,
    priority: 10,
    ...overrides,
  };
}

describe('isExhausted', () => {
  it('is true once attempts reach the maximum', () => {
    expect(isExhausted(3, 3)).toBe(true);
    expect(isExhausted(2, 3)).toBe(false);
  });

  it('falls back to the default attempt count when max is unset', () => {
    expect(isExhausted(3, 0)).toBe(true);
    expect(isExhausted(1, 0)).toBe(false);
  });
});

describe('buildDeadLetterRecord', () => {
  it('captures everything needed to replay the job', () => {
    const record = buildDeadLetterRecord(makeJob(), new Error('smtp down'));
    expect(record.originalJobId).toBe('job-1');
    expect(record.originalQueue).toBe('email');
    expect(record.payload).toEqual({ to: 'a@b.com' });
    expect(record.failedReason).toBe('smtp down');
    expect(record.attemptsMade).toBe(3);
    expect(typeof record.deadLetteredAt).toBe('string');
  });

  it('falls back to the job failure reason when no error is given', () => {
    const record = buildDeadLetterRecord(makeJob({ failedReason: 'timeout' }));
    expect(record.failedReason).toBe('timeout');
  });

  it('handles non-error failures', () => {
    const record = buildDeadLetterRecord(makeJob(), 'string failure');
    expect(record.failedReason).toBe('string failure');
  });
});

describe('isDeadLetterQueueName', () => {
  it('detects dead letter queues', () => {
    expect(isDeadLetterQueueName('email-dlq')).toBe(true);
    expect(isDeadLetterQueueName('email')).toBe(false);
  });
});

describe('DeadLetterManager', () => {
  it('parks failed jobs and lists them', async () => {
    const dlq = new InMemoryJobQueue('email-dlq');
    const manager = new DeadLetterManager(dlq);

    const stored = await manager.add(makeJob(), new Error('boom'));
    expect(stored.data.failedReason).toBe('boom');

    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(stored.id);
  });

  it('replays a dead lettered job onto a target queue', async () => {
    const dlq = new InMemoryJobQueue('email-dlq');
    const target = new InMemoryJobQueue('email');
    const manager = new DeadLetterManager(dlq);

    const stored = await manager.add(makeJob(), new Error('boom'));
    const replayed = await manager.replay(stored.id, target);

    expect(replayed).not.toBeNull();
    expect(replayed?.name).toBe('email.send');
    expect(replayed?.data).toEqual({ to: 'a@b.com' });
    expect(await dlq.getJob(stored.id)).toBeNull();
    expect(await target.list()).toHaveLength(1);
  });

  it('returns null when replaying an unknown record', async () => {
    const manager = new DeadLetterManager(new InMemoryJobQueue('email-dlq'));
    expect(await manager.replay('missing', new InMemoryJobQueue('email'))).toBeNull();
  });

  it('purges all dead lettered jobs', async () => {
    const dlq = new InMemoryJobQueue('email-dlq');
    const manager = new DeadLetterManager(dlq);

    await manager.add(makeJob({ id: 'a' }), new Error('boom'));
    await manager.add(makeJob({ id: 'b' }), new Error('boom'));

    expect(await manager.purge()).toBe(2);
    expect(await manager.list()).toHaveLength(0);
  });
});
