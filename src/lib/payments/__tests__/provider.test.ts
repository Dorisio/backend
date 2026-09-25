import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));

import axios from 'axios';
import { FakePaymentProvider } from '../provider';
import { StripePaymentProvider } from '../stripe-provider';
import { buildSignatureHeader } from '../webhook-signature';

const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

describe('FakePaymentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns deterministic, sequential references', async () => {
    const provider = new FakePaymentProvider({ status: 'succeeded' });
    const first = await provider.createPaymentIntent({
      amount: 10,
      currency: 'USD',
      method: 'card',
      idempotencyKey: 'k1',
    });
    const second = await provider.createPaymentIntent({
      amount: 10,
      currency: 'USD',
      method: 'card',
      idempotencyKey: 'k2',
    });

    expect(first.providerRef).toBe('pi_fake_1');
    expect(second.providerRef).toBe('pi_fake_2');
    expect(first.status).toBe('succeeded');
  });

  it('records calls for assertions', async () => {
    const provider = new FakePaymentProvider();
    await provider.createPaymentIntent({ amount: 1, currency: 'USD', method: 'crypto', idempotencyKey: 'k' });
    expect(provider.createdIntents).toHaveLength(1);
    expect(provider.createdIntents[0].method).toBe('crypto');
  });

  it('can be scripted to fail', async () => {
    const provider = new FakePaymentProvider({ failCreate: new Error('provider down') });
    await expect(
      provider.createPaymentIntent({ amount: 1, currency: 'USD', method: 'card', idempotencyKey: 'k' })
    ).rejects.toThrow('provider down');
  });

  it('verifies signatures it produced', () => {
    const provider = new FakePaymentProvider();
    const payload = JSON.stringify({ id: 'evt_1', type: 'x' });
    const signature = provider.sign(payload);

    expect(provider.verifyWebhook(payload, signature)).toBe(true);
    expect(provider.verifyWebhook(payload, 't=1,v1=bad')).toBe(false);
    expect(provider.parseWebhookEvent(payload, signature)).toMatchObject({ id: 'evt_1', type: 'x' });
  });
});

describe('StripePaymentProvider', () => {
  const config = { secretKey: 'sk_test', webhookSecret: 'whsec_test', apiBase: 'https://api.stripe.com' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires a secret key', () => {
    expect(() => new StripePaymentProvider({ secretKey: '' })).toThrow();
  });

  it('creates a payment intent with cents, method type and idempotency key', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { id: 'pi_123', status: 'requires_action', client_secret: 'cs_123' },
    });

    const provider = new StripePaymentProvider(config);
    const intent = await provider.createPaymentIntent({
      amount: 10.5,
      currency: 'USD',
      method: 'wallet',
      idempotencyKey: 'idem-1',
      description: 'Tip',
      metadata: { userId: 'u1' },
    });

    expect(intent).toMatchObject({ providerRef: 'pi_123', status: 'requires_action', clientSecret: 'cs_123' });

    const [url, body, options] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(body).toContain('amount=1050');
    expect(body).toContain('currency=usd');
    expect(body).toContain('payment_method_types%5B%5D=link');
    expect(options.headers['Idempotency-Key']).toBe('idem-1');
    expect(options.headers.Authorization).toBe('Bearer sk_test');
  });

  it('retrieves a payment intent', async () => {
    mockedAxios.get.mockResolvedValue({ data: { id: 'pi_1', status: 'succeeded' } });
    const provider = new StripePaymentProvider(config);

    const intent = await provider.retrievePaymentIntent('pi_1');
    expect(intent.status).toBe('succeeded');
    expect(mockedAxios.get.mock.calls[0][0]).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
  });

  it('creates refunds in the smallest currency unit', async () => {
    mockedAxios.post.mockResolvedValue({ data: { id: 're_1', status: 'succeeded', amount: 2500 } });
    const provider = new StripePaymentProvider(config);

    const refund = await provider.refund({
      providerRef: 'pi_1',
      amount: 25,
      currency: 'USD',
      idempotencyKey: 'idem-refund',
    });

    expect(refund).toMatchObject({ providerRef: 're_1', status: 'succeeded', amount: 25 });
    expect(mockedAxios.post.mock.calls[0][1]).toContain('payment_intent=pi_1');
  });

  it('verifies webhook signatures with the configured secret', () => {
    const provider = new StripePaymentProvider(config);
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const signature = buildSignatureHeader(payload, 'whsec_test', Math.floor(Date.now() / 1000));

    expect(provider.verifyWebhook(payload, signature)).toBe(true);
    expect(provider.verifyWebhook(payload, 't=1,v1=nope')).toBe(false);
    expect(provider.parseWebhookEvent(payload, signature)).toMatchObject({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
    });
  });

  it('refuses to parse webhooks when no secret is configured', () => {
    const provider = new StripePaymentProvider({ secretKey: 'sk_test' });
    expect(provider.verifyWebhook('{}', 't=1,v1=x')).toBe(false);
    expect(() => provider.parseWebhookEvent('{}', 't=1,v1=x')).toThrow();
  });
});
