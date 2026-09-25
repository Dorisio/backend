import { describe, it, expect } from 'vitest';
import { BULL_JOB_TYPES, redisConnectionOptions, toJobRecord } from '../bull-queue';

describe('redisConnectionOptions', () => {
  it('parses host and port from a redis url', () => {
    const options = redisConnectionOptions('redis://localhost:6380');
    expect(options).toMatchObject({ host: 'localhost', port: 6380 });
  });

  it('parses credentials and database index', () => {
    const options = redisConnectionOptions('redis://:secret@redis.internal:6379/2');
    expect(options).toMatchObject({
      host: 'redis.internal',
      port: 6379,
      password: 'secret',
      db: 2,
    });
  });

  it('parses a username when present', () => {
    const options = redisConnectionOptions('redis://default:secret@redis.internal:6379');
    expect(options.username).toBe('default');
    expect(options.password).toBe('secret');
  });

  it('enables tls for rediss urls', () => {
    const options = redisConnectionOptions('rediss://secure.redis:6380');
    expect(options.tls).toEqual({});
  });

  it('defaults the port when omitted', () => {
    const options = redisConnectionOptions('redis://localhost');
    expect(options.port).toBe(6379);
  });
});

describe('toJobRecord', () => {
  const baseJob = {
    id: 'job-1',
    name: 'email.send',
    queueName: 'email',
    data: { to: 'a@b.com' },
    progress: 40,
    attemptsMade: 1,
    opts: { attempts: 3, priority: 5 },
    failedReason: '',
    returnvalue: { delivered: true },
    timestamp: 1_700_000_000_000,
    processedOn: 1_700_000_000_100,
    finishedOn: 1_700_000_000_200,
    isFailed: () => false,
  };

  it('maps a completed job', () => {
    const record = toJobRecord(baseJob as never);
    expect(record).toMatchObject({
      id: 'job-1',
      name: 'email.send',
      queue: 'email',
      progress: 40,
      attemptsMade: 1,
      maxAttempts: 3,
      priority: 5,
      state: 'completed',
    });
    expect(record.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('maps a failed job', () => {
    const record = toJobRecord({
      ...baseJob,
      isFailed: () => true,
      failedReason: 'boom',
    } as never);
    expect(record.state).toBe('failed');
    expect(record.failedReason).toBeTruthy();
  });
});

describe('BULL_JOB_TYPES', () => {
  it('covers the BullMQ job types we monitor', () => {
    expect(BULL_JOB_TYPES).toContain('waiting');
    expect(BULL_JOB_TYPES).toContain('active');
    expect(BULL_JOB_TYPES).toContain('failed');
    expect(BULL_JOB_TYPES).toContain('completed');
  });
});
