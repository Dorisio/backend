import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { formatSuccess, formatError } from '../../types/response';
import { AppError } from '../../utils/errors';
import {
  verifyCreatorWebhookSignature,
  parseWebhookHeaders,
} from '../../lib/webhooks/creator-webhook-verification';
import { logger } from '../../utils/logger';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/**
 * Routes for receiving incoming webhooks FROM creators.
 * These webhooks must have valid HMAC-SHA256 signatures.
 */
export const registerIncomingWebhookRoutes = (app: FastifyInstance, prisma: PrismaClient): void => {
  // Register content type parser to preserve raw body for signature verification
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      (request as RawBodyRequest).rawBody = typeof body === 'string' ? body : '';
      if (!body) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err: any) {
        done(err);
      }
    });

    /**
     * POST /api/v1/webhooks/incoming/:webhookId
     *
     * Receive and verify incoming webhooks from creators.
     *
     * Required headers:
     * - X-Webhook-Signature: HMAC-SHA256 signature
     * - X-Webhook-Timestamp: Unix timestamp (seconds)
     * - X-Webhook-Nonce: Unique request identifier
     *
     * The signature is computed as: HMAC-SHA256(secret, "{timestamp}.{nonce}.{body}")
     */
    scope.post<{
      Params: { webhookId: string };
      Body: Record<string, unknown>;
    }>(
      '/api/v1/webhooks/incoming/:webhookId',
      {
        schema: {
          description: 'Receive incoming webhook from a creator with signature verification',
          params: {
            type: 'object',
            required: ['webhookId'],
            properties: {
              webhookId: { type: 'string', description: 'Webhook ID' },
            },
          },
          headers: {
            type: 'object',
            properties: {
              'x-webhook-signature': {
                type: 'string',
                description: 'HMAC-SHA256 signature of the request',
              },
              'x-webhook-timestamp': {
                type: 'string',
                description: 'Unix timestamp in seconds',
              },
              'x-webhook-nonce': {
                type: 'string',
                description: 'Unique nonce to prevent replay attacks',
              },
            },
          },
          response: {
            200: { description: 'Webhook received and verified' },
            400: { description: 'Invalid request or signature verification failed' },
            401: { description: 'Signature verification failed' },
            404: { description: 'Webhook not found' },
          },
        } as any,
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { webhookId } = request.params as { webhookId: string };

        try {
          // Get raw body for signature verification
          const rawBody = (request as RawBodyRequest).rawBody || JSON.stringify(request.body);

          // Parse webhook headers
          const headers = parseWebhookHeaders(
            request.headers as Record<string, string | string[] | undefined>
          );

          // Verify webhook signature
          const verificationResult = await verifyCreatorWebhookSignature(
            prisma,
            webhookId,
            rawBody,
            headers,
            undefined,
            request.ip
          );

          if (!verificationResult.valid) {
            logger.warn(
              {
                webhookId,
                reason: verificationResult.reason,
                timestamp: verificationResult.timestamp,
                headers: {
                  hasSignature: !!headers.signature,
                  hasTimestamp: !!headers.timestamp,
                  hasNonce: !!headers.nonce,
                },
              },
              'Incoming webhook verification failed'
            );

            reply
              .code(401)
              .send(
                formatError(
                  `Webhook verification failed: ${verificationResult.reason}`,
                  'WEBHOOK_VERIFICATION_FAILED'
                )
              );
            return;
          }

          // Log successful verification
          logger.info(
            {
              webhookId,
              timestamp: verificationResult.timestamp,
              usedPreviousSecret: verificationResult.usedPreviousSecret,
            },
            'Incoming webhook verified successfully'
          );

          // Process the webhook payload
          const body = request.body as Record<string, unknown>;

          // Here you would add your webhook processing logic
          // For now, we just acknowledge receipt
          await processIncomingWebhook(prisma, webhookId, body, verificationResult.timestamp!);

          reply.code(200).send(
            formatSuccess({
              received: true,
              webhookId,
              timestamp: verificationResult.timestamp,
            })
          );
        } catch (error) {
          logger.error(
            { webhookId, error: error instanceof Error ? error.message : 'Unknown error' },
            'Error processing incoming webhook'
          );

          if (error instanceof AppError) {
            reply.code(error.statusCode).send(formatError(error.message, error.code));
          } else {
            reply
              .code(500)
              .send(
                formatError('Internal server error processing webhook', 'WEBHOOK_PROCESSING_ERROR')
              );
          }
        }
      }
    );
  }); // Close scope.register

  /**
   * GET /api/v1/webhooks/:webhookId/verification-info
   *
   * Get information about webhook verification requirements.
   * This helps creators understand how to sign their webhooks.
   */
  app.get<{
    Params: { webhookId: string };
  }>(
    '/api/v1/webhooks/:webhookId/verification-info',
    {
      schema: {
        description: 'Get webhook verification requirements and information',
        params: {
          type: 'object',
          required: ['webhookId'],
          properties: {
            webhookId: { type: 'string', description: 'Webhook ID' },
          },
        },
        response: {
          200: { description: 'Verification information' },
          404: { description: 'Webhook not found' },
        },
      } as any,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { webhookId } = request.params as { webhookId: string };

      try {
        const webhook = await prisma.webhook.findUnique({
          where: { id: webhookId },
          select: {
            id: true,
            url: true,
            secretRotatedAt: true,
            active: true,
          },
        });

        if (!webhook) {
          reply.code(404).send(formatError('Webhook not found', 'WEBHOOK_NOT_FOUND'));
          return;
        }

        reply.send(
          formatSuccess({
            webhookId: webhook.id,
            url: webhook.url,
            active: webhook.active,
            algorithm: 'HMAC-SHA256',
            requiredHeaders: ['X-Webhook-Signature', 'X-Webhook-Timestamp', 'X-Webhook-Nonce'],
            signatureFormat: 'HMAC-SHA256({timestamp}.{nonce}.{body})',
            timestampTolerance: 300, // 5 minutes
            secretLastRotated: webhook.secretRotatedAt?.toISOString(),
          })
        );
      } catch (error) {
        logger.error(
          { webhookId, error: error instanceof Error ? error.message : 'Unknown error' },
          'Error getting verification info'
        );

        if (error instanceof AppError) {
          reply.code(error.statusCode).send(formatError(error.message, error.code));
        } else {
          throw error;
        }
      }
    }
  );
};

/**
 * Process incoming webhook payload.
 * This is where you would add your business logic for handling webhook events.
 */
async function processIncomingWebhook(
  prisma: PrismaClient,
  webhookId: string,
  payload: Record<string, unknown>,
  timestamp: number
): Promise<void> {
  // Log the received webhook for audit purposes
  await prisma.webhookEvent.create({
    data: {
      webhookId,
      eventType: (payload.event_type as string) || 'incoming.webhook',
      payload: JSON.stringify(payload),
      status: 'delivered',
      attempts: 1,
    },
  });

  logger.info(
    { webhookId, eventType: payload.event_type, timestamp },
    'Processed incoming webhook'
  );

  // Add your business logic here
  // For example:
  // - Update database records based on webhook data
  // - Trigger notifications
  // - Queue background jobs
  // - etc.
}
