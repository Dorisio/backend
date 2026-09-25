/**
 * Payment provider abstractions.
 *
 * The application talks to a `PaymentProvider` rather than a specific SDK, so
 * the concrete processor (Stripe today) can be swapped and so tests can use a
 * deterministic fake.
 */

export type PaymentMethod = 'card' | 'wallet' | 'crypto';

export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'refunded'
  | 'partially_refunded'
  | 'disputed';

export const TERMINAL_PAYMENT_STATUSES: PaymentStatus[] = [
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
  'disputed',
];

export const REFUNDABLE_PAYMENT_STATUSES: PaymentStatus[] = [
  'succeeded',
  'partially_refunded',
  'disputed',
];

export interface CreatePaymentIntentParams {
  amount: number;
  currency: string;
  method: PaymentMethod;
  description?: string;
  metadata?: Record<string, string>;
  /** Provider-level idempotency key (never the client's raw value). */
  idempotencyKey: string;
}

export interface ProviderPaymentIntent {
  providerRef: string;
  status: PaymentStatus;
  /** Client-side confirmation secret/token, when the provider returns one. */
  clientSecret?: string;
  raw?: unknown;
}

export interface ProviderRefundParams {
  providerRef: string;
  amount: number;
  currency: string;
  reason?: string;
  idempotencyKey: string;
}

export interface ProviderRefund {
  providerRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount: number;
  raw?: unknown;
}

export interface ProviderWebhookEvent {
  id: string;
  type: string;
  /** Normalized provider payload (the `data.object` for Stripe). */
  data: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<ProviderPaymentIntent>;
  retrievePaymentIntent(providerRef: string): Promise<ProviderPaymentIntent>;
  refund(params: ProviderRefundParams): Promise<ProviderRefund>;
  /** Verifies the provider's webhook signature over the raw request body. */
  verifyWebhook(rawBody: string, signature: string, secret: string): boolean;
  /** Verifies and parses a webhook payload. Throws on invalid signatures. */
  parseWebhookEvent(rawBody: string, signature: string, secret: string): ProviderWebhookEvent;
}

/**
 * Maps provider-specific status strings onto our internal status set.
 */
export function mapProviderStatus(status: unknown): PaymentStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'requires_action';
    case 'processing':
      return 'processing';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export function isTerminalPaymentStatus(status: string): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status as PaymentStatus);
}

export function isRefundablePaymentStatus(status: string): boolean {
  return REFUNDABLE_PAYMENT_STATUSES.includes(status as PaymentStatus);
}
