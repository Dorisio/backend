import axios from 'axios';
import { logger } from '../../utils/logger';
import {
  CreatePaymentIntentParams,
  PaymentProvider,
  ProviderPaymentIntent,
  ProviderRefund,
  ProviderRefundParams,
  ProviderWebhookEvent,
  mapProviderStatus,
} from './types';
import { verifyWebhookSignature } from './webhook-signature';

/**
 * Stripe payment provider.
 *
 * Uses Stripe's REST API directly (no SDK dependency) and tokenized payment
 * intents, so raw card data never reaches our servers (PCI SAQ-A).
 */

export interface StripeProviderConfig {
  secretKey: string;
  apiBase?: string;
  webhookSecret?: string;
  timeoutMs?: number;
}

const METHOD_TO_STRIPE_TYPE: Record<string, string> = {
  card: 'card',
  wallet: 'link',
  crypto: 'crypto',
};

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly secretKey: string;
  private readonly apiBase: string;
  private readonly webhookSecret?: string;
  private readonly timeoutMs: number;

  constructor(config: StripeProviderConfig) {
    if (!config.secretKey) {
      throw new Error('StripePaymentProvider requires a secret key');
    }
    this.secretKey = config.secretKey;
    this.apiBase = (config.apiBase ?? 'https://api.stripe.com').replace(/\/$/, '');
    this.webhookSecret = config.webhookSecret;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<ProviderPaymentIntent> {
    const body = new URLSearchParams();
    // Stripe expects the smallest currency unit (e.g. cents).
    body.set('amount', String(Math.round(params.amount * 100)));
    body.set('currency', params.currency.toLowerCase());
    body.set('payment_method_types[]', METHOD_TO_STRIPE_TYPE[params.method] ?? 'card');
    body.set('metadata[idempotency_key]', params.idempotencyKey);
    if (params.description) body.set('description', params.description);
    for (const [key, value] of Object.entries(params.metadata ?? {})) {
      body.set(`metadata[${key}]`, value);
    }

    const response = await axios.post(`${this.apiBase}/v1/payment_intents`, body.toString(), {
      headers: this.headers(params.idempotencyKey),
      timeout: this.timeoutMs,
    });

    return {
      providerRef: response.data.id,
      status: mapProviderStatus(response.data.status),
      clientSecret: response.data.client_secret,
      raw: response.data,
    };
  }

  async retrievePaymentIntent(providerRef: string): Promise<ProviderPaymentIntent> {
    const response = await axios.get(`${this.apiBase}/v1/payment_intents/${providerRef}`, {
      headers: this.headers(),
      timeout: this.timeoutMs,
    });

    return {
      providerRef: response.data.id,
      status: mapProviderStatus(response.data.status),
      clientSecret: response.data.client_secret,
      raw: response.data,
    };
  }

  async refund(params: ProviderRefundParams): Promise<ProviderRefund> {
    const body = new URLSearchParams();
    body.set('payment_intent', params.providerRef);
    body.set('amount', String(Math.round(params.amount * 100)));
    if (params.reason) body.set('reason', params.reason);

    const response = await axios.post(`${this.apiBase}/v1/refunds`, body.toString(), {
      headers: this.headers(params.idempotencyKey),
      timeout: this.timeoutMs,
    });

    const status = response.data.status === 'succeeded' ? 'succeeded' : response.data.status === 'failed' ? 'failed' : 'pending';

    return {
      providerRef: response.data.id,
      status,
      amount: (response.data.amount ?? 0) / 100,
      raw: response.data,
    };
  }

  verifyWebhook(rawBody: string, signature: string, secret?: string): boolean {
    const resolvedSecret = secret || this.webhookSecret;
    if (!resolvedSecret) {
      logger.warn('Stripe webhook received but no webhook secret is configured');
      return false;
    }
    return verifyWebhookSignature(rawBody, signature, resolvedSecret).valid;
  }

  parseWebhookEvent(rawBody: string, signature: string, secret?: string): ProviderWebhookEvent {
    const resolvedSecret = secret || this.webhookSecret;
    if (!resolvedSecret) {
      throw new Error('Webhook secret is not configured');
    }

    const verification = verifyWebhookSignature(rawBody, signature, resolvedSecret);
    if (!verification.valid) {
      throw new Error(`Invalid webhook signature: ${verification.reason}`);
    }

    const parsed = JSON.parse(rawBody) as { id: string; type: string; data?: { object?: Record<string, unknown> } };

    return {
      id: parsed.id,
      type: parsed.type,
      data: parsed.data?.object ?? {},
    };
  }
}
