import { config } from '../../config';
import { StripePaymentProvider } from './stripe-provider';
import {
  CreatePaymentIntentParams,
  PaymentProvider,
  ProviderPaymentIntent,
  ProviderRefund,
  ProviderRefundParams,
  ProviderWebhookEvent,
  mapProviderStatus,
} from './types';
import { buildSignatureHeader, verifyWebhookSignature } from './webhook-signature';

export type { PaymentProvider } from './types';

/**
 * Deterministic in-memory provider used by tests and local development. It never
 * touches the network and can be scripted to fail or to return specific
 * statuses.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  private sequence = 0;
  readonly createdIntents: CreatePaymentIntentParams[] = [];
  readonly refunds: ProviderRefundParams[] = [];

  constructor(
    private readonly options: {
      status?: string;
      refundStatus?: 'pending' | 'succeeded' | 'failed';
      webhookSecret?: string;
      failCreate?: Error;
      failRefund?: Error;
    } = {}
  ) {}

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<ProviderPaymentIntent> {
    if (this.options.failCreate) {
      throw this.options.failCreate;
    }
    this.createdIntents.push(params);
    this.sequence += 1;
    return {
      providerRef: `pi_fake_${this.sequence}`,
      status: mapProviderStatus(this.options.status ?? 'requires_confirmation'),
      clientSecret: `secret_fake_${this.sequence}`,
    };
  }

  async retrievePaymentIntent(providerRef: string): Promise<ProviderPaymentIntent> {
    return {
      providerRef,
      status: mapProviderStatus(this.options.status ?? 'requires_confirmation'),
    };
  }

  async refund(params: ProviderRefundParams): Promise<ProviderRefund> {
    if (this.options.failRefund) {
      throw this.options.failRefund;
    }
    this.refunds.push(params);
    this.sequence += 1;
    return {
      providerRef: `re_fake_${this.sequence}`,
      status: this.options.refundStatus ?? 'succeeded',
      amount: params.amount,
    };
  }

  verifyWebhook(rawBody: string, signature: string, secret?: string): boolean {
    const resolved = secret || this.options.webhookSecret || 'fake-webhook-secret';
    return verifyWebhookSignature(rawBody, signature, resolved).valid;
  }

  parseWebhookEvent(rawBody: string, signature: string, secret?: string): ProviderWebhookEvent {
    const resolved = secret || this.options.webhookSecret || 'fake-webhook-secret';
    const verification = verifyWebhookSignature(rawBody, signature, resolved);
    if (!verification.valid) {
      throw new Error(`Invalid webhook signature: ${verification.reason}`);
    }
    const parsed = JSON.parse(rawBody) as {
      id: string;
      type: string;
      data?: { object?: Record<string, unknown> };
    };
    return { id: parsed.id, type: parsed.type, data: parsed.data?.object ?? {} };
  }

  /** Test helper: signs a payload the same way the transport would. */
  sign(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
    return buildSignatureHeader(payload, this.options.webhookSecret ?? 'fake-webhook-secret', timestamp);
  }
}

export function createPaymentProvider(): PaymentProvider {
  if (config.PAYMENTS_PROVIDER === 'stripe') {
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error('PAYMENTS_PROVIDER=stripe requires STRIPE_SECRET_KEY to be set');
    }
    return new StripePaymentProvider({
      secretKey: config.STRIPE_SECRET_KEY,
      apiBase: config.STRIPE_API_BASE,
      webhookSecret: config.STRIPE_WEBHOOK_SECRET,
    });
  }
  return new FakePaymentProvider();
}

/** Resolves the webhook secret for the configured provider. */
export function resolveWebhookSecret(): string | undefined {
  return config.STRIPE_WEBHOOK_SECRET;
}

export function resolveWebhookToleranceSeconds(): number {
  return config.PAYMENTS_WEBHOOK_TOLERANCE_SECONDS;
}
