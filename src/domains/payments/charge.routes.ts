import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { UnauthorizedError } from '../../utils/errors';
import { formatSuccess } from '../../types/response';
import { authMiddleware } from '../../middleware/auth';
import { ChargeService } from './charge.service';
import {
  CreatePaymentInput,
  CreatePaymentSchema,
  ListPaymentsQueryInput,
  ListPaymentsQuerySchema,
  PaymentIdParamsSchema,
  RefundPaymentInput,
  RefundPaymentSchema,
} from './charge.types';
import { PaymentProvider } from '../../lib/payments/provider';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

function idempotencyKeyFrom(request: FastifyRequest, body?: { idempotencyKey?: string }): string {
  const header = request.headers['idempotency-key'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  return body?.idempotencyKey || headerValue || randomUUID();
}

/**
 * Registers the external payment processing endpoints.
 *
 * The routes are registered inside an encapsulated plugin so the JSON content
 * type parser can capture the raw request body (required for webhook signature
 * verification) without affecting the rest of the API.
 */
export const registerChargeRoutes = (
  app: FastifyInstance,
  prisma: PrismaClient,
  provider?: PaymentProvider
): void => {
  const service = new ChargeService(prisma, { provider });

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      (request as RawBodyRequest).rawBody = typeof body === 'string' ? body : '';
      if (!body) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    /**
     * POST /api/v1/payments/webhooks/:provider
     * Provider callback endpoint. No auth — authenticity comes from the
     * signature over the raw body.
     */
    scope.post<{ Params: { provider: string } }>(
      '/api/v1/payments/webhooks/:provider',
      {
        schema: {
          params: {
            type: 'object',
            required: ['provider'],
            properties: { provider: { type: 'string' } },
          },
          response: {
            200: { description: 'Webhook accepted' },
            400: { description: 'Invalid webhook payload' },
            401: { description: 'Invalid webhook signature' },
          },
        },
      },
      async (request: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
        const rawBody = (request as RawBodyRequest).rawBody ?? JSON.stringify(request.body ?? {});
        const signatureHeader = request.headers['stripe-signature'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

        const result = await service.handleWebhook(request.params.provider, rawBody, signature);
        reply.code(200).send(result);
      }
    );

    /**
     * POST /api/v1/payments
     * Create a payment intent. Requires authentication and an idempotency key
     * (header `Idempotency-Key` or body field), so retries cannot double charge.
     */
    scope.post<{ Body: CreatePaymentInput }>(
      '/api/v1/payments',
      {
        preHandler: [authMiddleware],
        schema: {
          body: {
            type: 'object',
            required: ['amount', 'method'],
            properties: {
              amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
              currency: {
                type: 'string',
                enum: ['USD', 'EUR', 'GBP', 'XLM', 'USDC'],
                default: 'USD',
              },
              method: { type: 'string', enum: ['card', 'wallet', 'crypto'] },
              creatorId: { type: 'string' },
              description: { type: 'string', maxLength: 500 },
              idempotencyKey: { type: 'string', minLength: 8, maxLength: 255 },
            },
          },
          response: {
            201: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                data: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    clientSecret: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreatePaymentInput }>, reply: FastifyReply) => {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('Authentication required');
        }

        const body = CreatePaymentSchema.parse(request.body);
        const result = await service.createPayment(user.userId, body, idempotencyKeyFrom(request, body));
        reply.code(201).send(formatSuccess(result));
      }
    );

    /**
     * GET /api/v1/payments
     * List the authenticated user's payments.
     */
    scope.get<{ Querystring: ListPaymentsQueryInput }>(
      '/api/v1/payments',
      {
        preHandler: [authMiddleware],
        schema: {
          querystring: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1, default: 1 },
              pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
              status: { type: 'string' },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: ListPaymentsQueryInput }>, reply: FastifyReply) => {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('Authentication required');
        }
        const query = ListPaymentsQuerySchema.parse(request.query ?? {});
        const result = await service.listPayments(user.userId, query);
        reply.send(formatSuccess(result));
      }
    );

    /**
     * GET /api/v1/payments/:id
     * Fetch a single payment the caller owns.
     */
    scope.get<{ Params: { id: string } }>(
      '/api/v1/payments/:id',
      {
        preHandler: [authMiddleware],
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('Authentication required');
        }
        const { id } = PaymentIdParamsSchema.parse(request.params);
        const result = await service.getPayment(id, user.userId);
        reply.send(formatSuccess(result));
      }
    );

    /**
     * POST /api/v1/payments/:id/refund
     * Refund a payment (in full or partially). Idempotent per refund key.
     */
    scope.post<{ Params: { id: string }; Body: RefundPaymentInput }>(
      '/api/v1/payments/:id/refund',
      {
        preHandler: [authMiddleware],
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          body: {
            type: 'object',
            properties: {
              amount: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
              reason: {
                type: 'string',
                enum: ['requested_by_customer', 'duplicate', 'fraudulent'],
              },
              idempotencyKey: { type: 'string', minLength: 8, maxLength: 255 },
            },
          },
          response: {
            201: { description: 'Refund created' },
          },
        },
      },
      async (request: FastifyRequest<{ Params: { id: string }; Body: RefundPaymentInput }>, reply: FastifyReply) => {
        const user = request.user;
        if (!user) {
          throw new UnauthorizedError('Authentication required');
        }
        const { id } = PaymentIdParamsSchema.parse(request.params);
        const body = RefundPaymentSchema.parse(request.body ?? {});
        const result = await service.refundPayment(id, user.userId, body, idempotencyKeyFrom(request, body));
        reply.code(201).send(formatSuccess(result));
      }
    );
  });
};
