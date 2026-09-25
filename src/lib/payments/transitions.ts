import { PaymentStatus } from './types';

/**
 * Payment status transition rules.
 *
 * Keeping the allowed transitions in one place means both the service and the
 * webhook processor agree on what a legal state change looks like, and illegal
 * transitions (for example a refund on a failed payment) are rejected.
 */

export const PAYMENT_EVENT_TYPES = {
  CREATED: 'payment.created',
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
  CANCELED: 'payment.canceled',
  REFUND_CREATED: 'refund.created',
  CHARGEBACK_CREATED: 'chargeback.created',
  WEBHOOK_RECEIVED: 'webhook.received',
} as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[keyof typeof PAYMENT_EVENT_TYPES];

const ALLOWED_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['requires_action', 'processing', 'succeeded', 'failed', 'canceled'],
  requires_action: ['processing', 'succeeded', 'failed', 'canceled'],
  processing: ['succeeded', 'failed', 'canceled'],
  succeeded: ['refunded', 'partially_refunded', 'disputed'],
  partially_refunded: ['refunded', 'disputed'],
  refunded: ['disputed'],
  disputed: ['refunded', 'partially_refunded'],
  failed: [],
  canceled: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) {
    return false;
  }
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Maps a provider webhook event onto the next status, or `null` when the event
 * should not change the payment state.
 */
export function transitionForWebhookEvent(
  eventType: string,
  currentStatus: PaymentStatus,
  object: Record<string, unknown> = {}
): PaymentStatus | null {
  const propose = (target: PaymentStatus): PaymentStatus | null =>
    canTransition(currentStatus, target) ? target : null;

  switch (eventType) {
    case 'payment_intent.succeeded':
      return propose('succeeded');

    case 'payment_intent.payment_failed':
      return propose('failed');

    case 'payment_intent.canceled':
      return propose('canceled');

    case 'charge.refunded': {
      const amount = typeof object.amount === 'number' ? object.amount : undefined;
      const amountRefunded =
        typeof object.amount_refunded === 'number' ? object.amount_refunded : undefined;
      const fullyRefunded =
        amount !== undefined && amountRefunded !== undefined && amountRefunded >= amount;
      return propose(fullyRefunded ? 'refunded' : 'partially_refunded');
    }

    case 'charge.dispute.created':
    case 'charge.dispute.funds_withdrawn':
      return propose('disputed');

    default:
      return null;
  }
}
