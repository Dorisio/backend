import { describe, expect, it } from 'vitest';
import {
  createWebhookSignature,
  isWebhookEventType,
  verifyWebhookSignature,
} from './events';

describe('webhook event contracts', () => {
  it('accepts only supported version 1 event types', () => {
    expect(isWebhookEventType('tip.created')).toBe(true);
    expect(isWebhookEventType('creator.verified')).toBe(true);
    expect(isWebhookEventType('payment.completed')).toBe(true);
    expect(isWebhookEventType('tip.confirmed')).toBe(false);
  });

  it('creates and verifies an HMAC SHA-256 signature over the raw body', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'tip.created', version: '1' });
    const signature = createWebhookSignature(body, 'secret');
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature(body, 'secret', signature)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, 'secret', signature)).toBe(false);
    expect(verifyWebhookSignature(body, 'wrong-secret', signature)).toBe(false);
  });
});
