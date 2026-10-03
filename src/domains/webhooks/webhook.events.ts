import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_EVENT_TYPES = [
  'tip.created',
  'creator.verified',
  'payment.completed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEventEnvelope<
  T = Record<string, unknown>,
> {
  id: string;
  type: WebhookEventType;
  version: '1';
  createdAt: string;
  data: T;
}

export const isWebhookEventType = (
  event: string,
): event is WebhookEventType =>
  (WEBHOOK_EVENT_TYPES as readonly string[]).includes(event);

/**
 * Creates an HMAC SHA-256 signature for a webhook payload.
 *
 * Format:
 * sha256=<hex-digest>
 */
export const createWebhookSignature = (
  rawBody: string,
  secret: string,
): string => {
  const digest = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  return `sha256=${digest}`;
};

/**
 * Verifies a webhook signature using a timing-safe comparison.
 */
export const verifyWebhookSignature = (
  rawBody: string,
  secret: string,
  signature: string,
): boolean => {
  if (!signature?.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = createWebhookSignature(rawBody, secret);

  const expected = Buffer.from(expectedSignature, 'utf8');
  const supplied = Buffer.from(signature, 'utf8');

  if (expected.length !== supplied.length) {
    return false;
  }

  return timingSafeEqual(expected, supplied);
};