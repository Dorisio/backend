import { describe, it, expect, beforeEach } from 'vitest';
import { ChargeService } from '../charge.service';
import { FakePrisma } from './fake-prisma';
import { FakePaymentProvider } from '../../../lib/payments/provider';
import { PaymentProvider } from '../../../lib/payments/types';
import { AppError, ValidationError, UnauthorizedError } from '../../../utils/errors';

const noSleep = async (): Promise<void> => undefined;

function buildService(options: {
  prisma: FakePrisma;
  provider?: PaymentProvider;
  webhookSecret?: string;
}): ChargeService {
  return new ChargeService(options.prisma as never, {
    provider: options.provider ?? new FakePaymentProvider(),
    retry: { attempts: 3, sleep: noSleep },
    webhookSecret: options.webhookSecret,
    webhookToleranceSeconds: 300,
  });
}

function signedPayload(provider: FakePaymentProvider, event: Record<string, unknown>): {
  payload: string;
  signature: string;
} {
  const payload = JSON.stringify(event);
  return { payload, signature: provider.sign(payload) };
}

describe('ChargeService.createPayment', () => {
  let prisma: FakePrisma;
  let provider: FakePaymentProvider;
  let service: ChargeService;

  beforeEach(() => {
    prisma = new FakePrisma();
    provider = new FakePaymentProvider({ status: 'requires_confirmation' });
    service = buildService({ prisma, provider });
  });

  it('creates a tokenized payment and audit event', async () => {
    const payment = await service.createPayment(
      'user-1',
      { amount: 25, currency: 'USD', method: 'card', creatorId: 'creator-1', description: 'Tip' },
      'key-1'
    );

    expect(payment.id).toBeDefined();
    expect(payment.status).toBe('requires_action');
    expect(payment.provider).toBe('fake');
    expect(payment.clientSecret).toBeDefined();
    expect(prisma.payments).toHaveLength(1);
    expect(prisma.events.map((event) => event.type)).toContain('payment.created');
  });

  it('does not store raw card data', async () => {
    await service.createPayment('user-1', { amount: 10, currency: 'USD', method: 'card' }, 'key-2');
    const stored = JSON.stringify(prisma.payments[0]);
    expect(stored).not.toMatch(/card_number|cardNumber|cvc|pan/i);
  });

  it('is idempotent for the same key', async () => {
    const first = await service.createPayment('user-1', { amount: 10, currency: 'USD', method: 'card' }, 'key-3');
    const second = await service.createPayment('user-1', { amount: 10, currency: 'USD', method: 'card' }, 'key-3');

    expect(second.id).toBe(first.id);
    expect(prisma.payments).toHaveLength(1);
    expect(provider.createdIntents).toHaveLength(1);
  });

  it('rejects an idempotency key reused by another user', async () => {
    await service.createPayment('user-1', { amount: 10, currency: 'USD', method: 'card' }, 'key-4');

    await expect(
      service.createPayment('user-2', { amount: 10, currency: 'USD', method: 'card' }, 'key-4')
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects non-positive amounts', async () => {
    await expect(
      service.createPayment('user-1', { amount: 0, currency: 'USD', method: 'card' }, 'key-5')
    ).rejects.toThrow(ValidationError);
  });

  it('retries transient provider failures', async () => {
    let calls = 0;
    const flaky: PaymentProvider = {
      name: 'flaky',
      createPaymentIntent: async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('upstream 500') as Error & { response?: { status: number } };
          error.response = { status: 500 };
          throw error;
        }
        return { providerRef: 'pi_flaky', status: 'pending' };
      },
      retrievePaymentIntent: async () => ({ providerRef: 'pi_flaky', status: 'pending' }),
      refund: async () => ({ providerRef: 're', status: 'succeeded', amount: 0 }),
      verifyWebhook: () => true,
      parseWebhookEvent: () => ({ id: 'e', type: 't', data: {} }),
    };

    const flakyService = buildService({ prisma, provider: flaky });
    const payment = await flakyService.createPayment(
      'user-1',
      { amount: 5, currency: 'USD', method: 'card' },
      'key-retry'
    );

    expect(calls).toBe(3);
    expect(payment.provider).toBe('flaky');
  });
});

describe('ChargeService.getPayment / listPayments', () => {
  let prisma: FakePrisma;
  let service: ChargeService;

  beforeEach(async () => {
    prisma = new FakePrisma();
    service = buildService({ prisma, provider: new FakePaymentProvider() });
    await service.createPayment('user-1', { amount: 10, currency: 'USD', method: 'card' }, 'a');
    await service.createPayment('user-1', { amount: 20, currency: 'USD', method: 'card' }, 'b');
    await service.createPayment('user-2', { amount: 30, currency: 'USD', method: 'card' }, 'c');
  });

  it('returns a payment for its owner', async () => {
    const listed = await service.listPayments('user-1');
    const payment = await service.getPayment(listed.payments[0].id, 'user-1');
    expect(payment.userId).toBe('user-1');
  });

  it('rejects access by a different user', async () => {
    const listed = await service.listPayments('user-1');
    await expect(service.getPayment(listed.payments[0].id, 'user-2')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('throws not-found for unknown payments', async () => {
    await expect(service.getPayment('missing', 'user-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('paginates and filters by user', async () => {
    const page = await service.listPayments('user-1', { page: 1, pageSize: 1 });
    expect(page.total).toBe(2);
    expect(page.payments).toHaveLength(1);
    expect(page.totalPages).toBe(2);
  });
});

describe('ChargeService.refundPayment', () => {
  let prisma: FakePrisma;
  let provider: FakePaymentProvider;
  let service: ChargeService;
  let paymentId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    provider = new FakePaymentProvider({ status: 'succeeded', refundStatus: 'succeeded' });
    service = buildService({ prisma, provider });
    const payment = await service.createPayment(
      'user-1',
      { amount: 100, currency: 'USD', method: 'card' },
      'payment-key'
    );
    paymentId = payment.id;
  });

  it('fully refunds a payment', async () => {
    const refund = await service.refundPayment(paymentId, 'user-1', {}, 'refund-1');
    expect(refund.amount).toBe(100);
    expect(refund.status).toBe('succeeded');

    const payment = await service.getPayment(paymentId, 'user-1');
    expect(payment.status).toBe('refunded');
    expect(payment.refundedAmount).toBe(100);
  });

  it('supports partial refunds', async () => {
    await service.refundPayment(paymentId, 'user-1', { amount: 30 }, 'refund-partial');
    const payment = await service.getPayment(paymentId, 'user-1');
    expect(payment.status).toBe('partially_refunded');
    expect(payment.refundedAmount).toBe(30);
  });

  it('prevents over-refunding', async () => {
    await service.refundPayment(paymentId, 'user-1', { amount: 60 }, 'refund-a');
    await expect(
      service.refundPayment(paymentId, 'user-1', { amount: 60 }, 'refund-b')
    ).rejects.toThrow(ValidationError);
  });

  it('is idempotent per refund key', async () => {
    const first = await service.refundPayment(paymentId, 'user-1', { amount: 20 }, 'refund-idem');
    const second = await service.refundPayment(paymentId, 'user-1', { amount: 20 }, 'refund-idem');
    expect(second.id).toBe(first.id);
    expect(provider.refunds).toHaveLength(1);
  });

  it('rejects refunds from another user', async () => {
    await expect(
      service.refundPayment(paymentId, 'user-2', {}, 'refund-other')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects refunds on non-refundable payments', async () => {
    const failed = new FakePaymentProvider({ status: 'failed' });
    const failedService = buildService({ prisma, provider: failed });
    const payment = await failedService.createPayment(
      'user-1',
      { amount: 10, currency: 'USD', method: 'card' },
      'failed-key'
    );
    await expect(failedService.refundPayment(payment.id, 'user-1', {}, 'refund-failed')).rejects.toThrow(
      ValidationError
    );
  });

  it('records an audit event for the refund', async () => {
    await service.refundPayment(paymentId, 'user-1', {}, 'refund-event');
    expect(prisma.events.map((event) => event.type)).toContain('refund.created');
  });
});

describe('ChargeService.handleWebhook', () => {
  let prisma: FakePrisma;
  let provider: FakePaymentProvider;
  let service: ChargeService;
  let paymentId: string;
  let providerRef: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    provider = new FakePaymentProvider({ status: 'requires_confirmation' });
    service = buildService({ prisma, provider });
    const payment = await service.createPayment(
      'user-1',
      { amount: 50, currency: 'USD', method: 'card' },
      'webhook-payment'
    );
    paymentId = payment.id;
    providerRef = prisma.payments[0].providerRef;
  });

  it('rejects an invalid signature', async () => {
    const payload = JSON.stringify({ id: 'evt_bad', type: 'payment_intent.succeeded', data: { object: { id: providerRef } } });
    await expect(service.handleWebhook('fake', payload, 't=1,v1=deadbeef')).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it('rejects an unsupported provider', async () => {
    const payload = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: providerRef } } });
    const { signature } = signedPayload(provider, JSON.parse(payload));
    await expect(service.handleWebhook('paypal', payload, signature)).rejects.toBeInstanceOf(ValidationError);
  });

  it('updates the payment status on success events', async () => {
    const { payload, signature } = signedPayload(provider, {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: providerRef } },
    });

    const result = await service.handleWebhook('fake', payload, signature);
    expect(result).toMatchObject({ received: true, handled: true, status: 'succeeded' });

    const payment = await service.getPayment(paymentId, 'user-1');
    expect(payment.status).toBe('succeeded');
  });

  it('is idempotent for redelivered events', async () => {
    const { payload, signature } = signedPayload(provider, {
      id: 'evt_dup',
      type: 'payment_intent.succeeded',
      data: { object: { id: providerRef } },
    });

    await service.handleWebhook('fake', payload, signature);
    const second = await service.handleWebhook('fake', payload, signature);
    expect(second).toMatchObject({ handled: false, duplicate: true });
  });

  it('records disputes as chargebacks', async () => {
    const success = signedPayload(provider, {
      id: 'evt_ok',
      type: 'payment_intent.succeeded',
      data: { object: { id: providerRef } },
    });
    await service.handleWebhook('fake', success.payload, success.signature);

    const dispute = signedPayload(provider, {
      id: 'evt_dispute',
      type: 'charge.dispute.created',
      data: { object: { id: providerRef } },
    });
    const result = await service.handleWebhook('fake', dispute.payload, dispute.signature);
    expect(result.status).toBe('disputed');
  });

  it('ignores events for unknown payments', async () => {
    const { payload, signature } = signedPayload(provider, {
      id: 'evt_unknown',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_does_not_exist' } },
    });

    const result = await service.handleWebhook('fake', payload, signature);
    expect(result).toMatchObject({ received: true, handled: false });
  });

  it('ignores events without a provider reference', async () => {
    const { payload, signature } = signedPayload(provider, {
      id: 'evt_no_ref',
      type: 'customer.created',
      data: { object: { object: 'customer' } },
    });

    const result = await service.handleWebhook('fake', payload, signature);
    expect(result).toMatchObject({ received: true, handled: false });
  });
});

describe('provider configuration', () => {
  it('exposes the configured provider name', () => {
    const service = buildService({ prisma: new FakePrisma(), provider: new FakePaymentProvider() });
    expect(service.providerName).toBe('fake');
  });

  it('rejects webhooks when no secret is configured for a real provider', async () => {
    const realish: PaymentProvider = {
      name: 'stripe',
      createPaymentIntent: async () => ({ providerRef: 'x', status: 'pending' }),
      retrievePaymentIntent: async () => ({ providerRef: 'x', status: 'pending' }),
      refund: async () => ({ providerRef: 'x', status: 'succeeded', amount: 0 }),
      verifyWebhook: () => true,
      parseWebhookEvent: () => ({ id: 'e', type: 't', data: {} }),
    };
    const service = new ChargeService(new FakePrisma() as never, { provider: realish, webhookSecret: undefined });

    await expect(service.handleWebhook('stripe', '{}', 'sig')).rejects.toBeInstanceOf(AppError);
  });
});
