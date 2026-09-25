import { describe, it, expect } from 'vitest';
import {
  JOB_PRIORITY_VALUES,
  QUEUE_NAMES,
  deadLetterQueueName,
  emptyQueueCounts,
  resolvePriority,
} from '../types';

describe('queue naming', () => {
  it('derives dead letter queue names', () => {
    expect(deadLetterQueueName('email')).toBe('email-dlq');
    expect(deadLetterQueueName(QUEUE_NAMES.ANALYTICS)).toBe('analytics-dlq');
  });
});

describe('resolvePriority', () => {
  it('defaults to normal priority', () => {
    expect(resolvePriority(undefined)).toBe(JOB_PRIORITY_VALUES.normal);
  });

  it('maps labels onto BullMQ numeric priorities', () => {
    expect(resolvePriority('critical')).toBeLessThan(resolvePriority('high'));
    expect(resolvePriority('high')).toBeLessThan(resolvePriority('normal'));
    expect(resolvePriority('normal')).toBeLessThan(resolvePriority('low'));
  });

  it('passes numeric priorities through unchanged', () => {
    expect(resolvePriority(3)).toBe(3);
  });

  it('falls back to normal for unknown labels', () => {
    expect(resolvePriority('bogus' as unknown as 'normal')).toBe(JOB_PRIORITY_VALUES.normal);
  });
});

describe('emptyQueueCounts', () => {
  it('returns a zeroed count object', () => {
    expect(Object.values(emptyQueueCounts()).every((value) => value === 0)).toBe(true);
  });
});
