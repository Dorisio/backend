import { describe, it, expect } from 'vitest';
import { canTransition, transitionForWebhookEvent } from '../transitions';

describe('canTransition', () => {
  it('allows forward transitions', () => {
    expect(canTransition('pending', 'succeeded')).toBe(true);
    expect(canTransition('processing', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'refunded')).toBe(true);
    expect(canTransition('succeeded', 'disputed')).toBe(true);
  });

  it('rejects illegal or no-op transitions', () => {
    expect(canTransition('failed', 'succeeded')).toBe(false);
    expect(canTransition('canceled', 'succeeded')).toBe(false);
    expect(canTransition('pending', 'refunded')).toBe(false);
    expect(canTransition('succeeded', 'succeeded')).toBe(false);
  });
});

describe('transitionForWebhookEvent', () => {
  it('maps success, failure and cancellation events', () => {
    expect(transitionForWebhookEvent('payment_intent.succeeded', 'pending')).toBe('succeeded');
    expect(transitionForWebhookEvent('payment_intent.payment_failed', 'pending')).toBe('failed');
    expect(transitionForWebhookEvent('payment_intent.canceled', 'pending')).toBe('canceled');
  });

  it('distinguishes full and partial refunds', () => {
    expect(
      transitionForWebhookEvent('charge.refunded', 'succeeded', { amount: 1000, amount_refunded: 1000 })
    ).toBe('refunded');
    expect(
      transitionForWebhookEvent('charge.refunded', 'succeeded', { amount: 1000, amount_refunded: 400 })
    ).toBe('partially_refunded');
  });

  it('maps disputes to the disputed status', () => {
    expect(transitionForWebhookEvent('charge.dispute.created', 'succeeded')).toBe('disputed');
  });

  it('ignores unrelated events and illegal transitions', () => {
    expect(transitionForWebhookEvent('customer.created', 'pending')).toBeNull();
    expect(transitionForWebhookEvent('payment_intent.succeeded', 'failed')).toBeNull();
  });
});
