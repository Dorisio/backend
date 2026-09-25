import { Prisma, PrismaClient } from '@prisma/client';
import { BaseService } from '../../services/base.service';
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { PaymentProvider, createPaymentProvider, resolveWebhookSecret, resolveWebhookToleranceSeconds } from '../../lib/payments/provider';
import { isRetryableProviderError, retryOperation, RetryOptions } from '../../lib/payments/retry';
import { PAYMENT_EVENT_TYPES, canTransition, transitionForWebhookEvent } from '../../lib/payments/transitions';
import { PaymentStatus, isRefundablePaymentStatus } from '../../lib/payments/types';
import { verifyWebhookSignature } from '../../lib/payments/webhook-signature';
import {
  CreatePaymentInput,
  ListPaymentsQueryInput,
  PaymentListResponse,
  PaymentResponse,
  RefundPaymentInput,
  RefundResponse,
  WebhookResult,
} from './charge.types';

export interface ChargeServiceOptions {
  provider?: PaymentProvider;
  retry?: RetryOptions;
  webhookSecret?: string;
  webhookToleranceSeconds?: number;
}

/**
 * Payment processing service.
 *
 * Responsibilities:
 * - create tokenized payment intents through the configured provider
 * - idempotent creation/refunds keyed by an idempotency key
 * - status tracking with an append-only audit trail
 * - refunds with over-refund protection
 * - verified, idempotent webhook processing (including chargebacks)
 *
 * Raw card data is never accepted or stored — only provider references.
 */
export class ChargeService extends BaseService {
  private readonly provider: PaymentProvider;
  private readonly retry: RetryOptions;
  private readonly webhookSecret?: string;
  private readonly webhookToleranceSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: ChargeServiceOptions = {}
  ) {
    super();
    this.provider = options.provider ?? createPaymentProvider();
    this.retry = options.retry ?? { attempts: 3, sleep: async () => undefined };
    this.webhookSecret = options.webhookSecret ?? resolveWebhookSecret();
    this.webhookToleranceSeconds = options.webhookToleranceSeconds ?? resolveWebhookToleranceSeconds();
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** Creates (or returns the existing) payment for an idempotency key. */
  async createPayment(userId: string, input: CreatePaymentInput, idempotencyKey: string): Promise<PaymentResponse> {
    return this.executeWithLogging('payments.create', async () => {
      const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey }, include: { refunds: true } });
      if (existing) {
        if (existing.userId !== userId) {
          throw new AppError(409, 'CONFLICT', 'Idempotency key already used by another user');
        }
        return this.toResponse(existing);
      }

      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new ValidationError('Amount must be greater than 0');
      }

      const intent = await retryOperation(
        () =>
          this.provider.createPaymentIntent({
            amount: input.amount,
            currency: input.currency,
            method: input.method,
            description: input.description,
            metadata: { userId, ...(input.creatorId ? { creatorId: input.creatorId } : {}) },
            idempotencyKey,
          }),
        { ...this.retry, shouldRetry: (error) => isRetryableProviderError(error) }
      );

      const payment = await this.prisma.payment.create({
        data: {
          idempotencyKey,
          userId,
          creatorId: input.creatorId ?? null,
          provider: this.provider.name,
          providerRef: intent.providerRef,
          method: input.method,
          amount: input.amount,
          currency: input.currency,
          status: intent.status,
          description: input.description ?? null,
        },
        include: { refunds: true },
      });

      await this.recordEvent(payment.id, PAYMENT_EVENT_TYPES.CREATED, userId, {
        provider: this.provider.name,
        providerRef: intent.providerRef,
        amount: input.amount,
        currency: input.currency,
        method: input.method,
      });

      logger.info({ paymentId: payment.id, provider: this.provider.name }, 'Payment created');

      return { ...this.toResponse(payment), clientSecret: intent.clientSecret };
    });
  }

  async getPayment(paymentId: string, userId?: string): Promise<PaymentResponse> {
    return this.executeWithLogging('payments.get', async () => {
      const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
      if (!payment) {
        throw new NotFoundError('Payment');
      }
      if (userId && payment.userId !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Payment belongs to another user');
      }
      return this.toResponse(payment);
    });
  }

  async listPayments(userId: string, query: ListPaymentsQueryInput = {}): Promise<PaymentListResponse> {
    return this.executeWithLogging('payments.list', async () => {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const where: Record<string, unknown> = { userId };
      if (query.status) {
        where.status = query.status;
      }

      const [payments, total] = await Promise.all([
        this.prisma.payment.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { refunds: true },
        }),
        this.prisma.payment.count({ where }),
      ]);

      return {
        payments: payments.map((payment) => this.toResponse(payment)),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    });
  }

  /**
   * Refunds a payment (fully when no amount is given). Idempotent per refund
   * idempotency key and protected against over-refunding.
   */
  async refundPayment(paymentId: string, userId: string, input: RefundPaymentInput, idempotencyKey: string): Promise<RefundResponse> {
    return this.executeWithLogging('payments.refund', async () => {
      const existingRefund = await this.prisma.refund.findUnique({ where: { idempotencyKey } });
      if (existingRefund) {
        return this.toRefundResponse(existingRefund);
      }

      const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
      if (!payment) {
        throw new NotFoundError('Payment');
      }
      if (payment.userId !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'Payment belongs to another user');
      }
      if (!isRefundablePaymentStatus(payment.status)) {
        throw new ValidationError(`Payment in status "${payment.status}" cannot be refunded`);
      }
      if (!payment.providerRef) {
        throw new ValidationError('Payment has no provider reference to refund');
      }

      const alreadyRefunded = this.sumRefunded(payment.refunds ?? []);
      const remaining = payment.amount - alreadyRefunded;
      const amount = input.amount ?? remaining;

      if (amount <= 0) {
        throw new ValidationError('Nothing left to refund');
      }
      if (amount > remaining) {
        throw new ValidationError(`Refund exceeds the refundable amount of ${remaining}`);
      }

      const providerRefund = await retryOperation(
        () =>
          this.provider.refund({
            providerRef: payment.providerRef as string,
            amount,
            currency: payment.currency,
            reason: input.reason,
            idempotencyKey,
          }),
        { ...this.retry, shouldRetry: (error) => isRetryableProviderError(error) }
      );

      const refund = await this.prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKey,
          amount,
          currency: payment.currency,
          reason: input.reason ?? null,
          status: providerRefund.status,
          providerRef: providerRefund.providerRef,
        },
      });

      const totalRefunded = alreadyRefunded + (providerRefund.status === 'succeeded' ? amount : 0);
      const nextStatus: PaymentStatus = totalRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
      if (providerRefund.status === 'succeeded' && canTransition(payment.status as PaymentStatus, nextStatus)) {
        await this.prisma.payment.update({ where: { id: payment.id }, data: { status: nextStatus } });
      }

      await this.recordEvent(payment.id, PAYMENT_EVENT_TYPES.REFUND_CREATED, userId, {
        refundId: refund.id,
        amount,
        currency: payment.currency,
        reason: input.reason ?? null,
      });

      logger.info({ paymentId: payment.id, refundId: refund.id, amount }, 'Payment refunded');

      return this.toRefundResponse(refund);
    });
  }

  /**
   * Verifies and processes a provider webhook. Signature verification happens
   * before any state change and duplicate deliveries are ignored via the unique
   * provider event id.
   */
  async handleWebhook(providerName: string, rawBody: string, signature?: string): Promise<WebhookResult> {
    return this.executeWithLogging('payments.webhook', async () => {
      if (providerName !== this.provider.name && providerName !== 'stripe') {
        throw new ValidationError(`Unsupported payment provider "${providerName}"`);
      }

      const secret = this.webhookSecret ?? (this.provider.name === 'fake' ? 'fake-webhook-secret' : undefined);
      if (!secret) {
        throw new ValidationError('Webhook secret is not configured');
      }

      const verification = verifyWebhookSignature(rawBody, signature, secret, {
        toleranceSeconds: this.webhookToleranceSeconds,
      });
      if (!verification.valid) {
        logger.warn({ provider: providerName, reason: verification.reason }, 'Rejected webhook signature');
        throw new UnauthorizedError('Invalid webhook signature');
      }

      const event = JSON.parse(rawBody) as {
        id: string;
        type: string;
        data?: { object?: Record<string, unknown> };
      };
      const object = event.data?.object ?? {};
      const providerRef = (object.id as string) ?? (object.payment_intent as string) ?? undefined;

      if (!providerRef) {
        logger.warn({ eventId: event.id, type: event.type }, 'Webhook without a provider reference');
        return { received: true, handled: false };
      }

      const payment = await this.prisma.payment.findFirst({ where: { providerRef } });
      if (!payment) {
        logger.warn({ eventId: event.id, providerRef }, 'Webhook for unknown payment');
        return { received: true, handled: false };
      }

      // Idempotency: the unique providerEventId makes redelivery a no-op.
      try {
        await this.prisma.paymentEvent.create({
          data: {
            paymentId: payment.id,
            type: event.type,
            actor: 'provider',
            data: object as unknown as Prisma.InputJsonValue,
            providerEventId: event.id,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { received: true, handled: false, duplicate: true };
        }
        throw error;
      }

      const nextStatus = transitionForWebhookEvent(event.type, payment.status as PaymentStatus, object);
      if (nextStatus && nextStatus !== payment.status) {
        await this.prisma.payment.update({ where: { id: payment.id }, data: { status: nextStatus } });
        logger.info({ paymentId: payment.id, eventId: event.id, status: nextStatus }, 'Payment status updated from webhook');
      }

      return { received: true, handled: true, status: nextStatus };
    });
  }

  private async recordEvent(
    paymentId: string,
    type: string,
    actor: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.paymentEvent.create({
      data: { paymentId, type, actor, data: data as unknown as Prisma.InputJsonValue },
    });
  }

  private sumRefunded(refunds: Array<{ amount: number; status?: string }>): number {
    return refunds
      .filter((refund) => refund.status === undefined || refund.status === 'succeeded')
      .reduce((sum, refund) => sum + refund.amount, 0);
  }

  private toResponse(payment: {
    id: string;
    userId: string;
    creatorId?: string | null;
    provider: string;
    providerRef?: string | null;
    method: string;
    amount: number;
    currency: string;
    status: string;
    description?: string | null;
    createdAt: Date;
    updatedAt: Date;
    refunds?: Array<{ amount: number; status?: string }>;
  }): PaymentResponse {
    return {
      id: payment.id,
      userId: payment.userId,
      creatorId: payment.creatorId ?? null,
      provider: payment.provider,
      providerRef: payment.providerRef ?? null,
      method: payment.method as PaymentResponse['method'],
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status as PaymentStatus,
      description: payment.description ?? null,
      refundedAmount: this.sumRefunded(payment.refunds ?? []),
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    };
  }

  private toRefundResponse(refund: {
    id: string;
    paymentId: string;
    amount: number;
    currency: string;
    status: string;
    reason?: string | null;
    providerRef?: string | null;
    createdAt: Date;
  }): RefundResponse {
    return {
      id: refund.id,
      paymentId: refund.paymentId,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason ?? null,
      providerRef: refund.providerRef ?? null,
      createdAt: refund.createdAt.toISOString(),
    };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    const code = (error as { code?: string })?.code;
    return code === 'P2002';
  }
}
