import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES, webhookRetryQueue } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { executeWithBreaker, CircuitBreakerOpenError } from '../circuit-breaker';
import { createWebhookSignature } from '../../domains/webhooks/webhook.events';
import { requestIdHeaders } from '../requestContext';
import { withWorkerContext, runWithJobContext } from './middleware';

const prisma = new PrismaClient();

export function createWebhookDispatchWorker() {
  const worker = new Worker(
    QUEUE_NAMES.webhookDispatch,
    withWorkerContext(async (job: Job) => {
      const { webhookId, eventType, payload, eventId } = job.data;

      logger.info(`Dispatching webhook ${webhookId} for ${eventType} event`);
      await job.updateProgress(20);

      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
        select: {
          id: true,
          url: true,
          secret: true,
          active: true,
          events: true,
        },
      });

      if (!webhook) {
        throw new Error(`Webhook ${webhookId} not found`);
      }

      if (!webhook.active || !webhook.events.includes(eventType)) {
        throw new Error('Webhook is inactive or no longer subscribed');
      }

      const rawPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);

      const signature = createWebhookSignature(rawPayload, webhook.secret);

      await job.updateProgress(60);

      let response;

      try {
        response = await executeWithBreaker('webhook-dispatch', async () => {
          return axios.post(webhook.url, rawPayload, {
            headers: {
              'Content-Type': 'application/json',
              'X-Dorisio-Signature': signature,
              'X-Dorisio-Event': eventType,
              'X-Dorisio-Delivery-Id': eventId,
              'X-Dorisio-Event-Version': '1',
              ...requestIdHeaders(String(job.data.requestId ?? eventId ?? job.id)),
            },
            timeout: 10_000,
            maxRedirects: 0,
            validateStatus: () => true,
          });
        });
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          response = null;
        } else {
          const message = error instanceof Error ? error.message : String(error);

          if (eventId) {
            await prisma.webhookEvent.update({
              where: { id: eventId },
              data: {
                status: 'pending',
                attempts: job.attemptsMade + 1,
                lastError: message,
                updatedAt: new Date(),
              },
            });
          }

          throw error;
        }
      }

      if (response === null) {
        if (eventId) {
          await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
              status: 'pending',
              attempts: job.attemptsMade + 1,
              lastError: 'Circuit breaker open',
              updatedAt: new Date(),
            },
          });
        }

        throw new Error('Webhook delivery skipped: circuit breaker open');
      }

      const delivered = response.status >= 200 && response.status < 300;

      if (eventId) {
        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: delivered ? 'delivered' : 'pending',
            attempts: job.attemptsMade + 1,
            lastError: delivered ? null : `HTTP ${response.status}`,
            updatedAt: new Date(),
          },
        });
      }

      if (!delivered) {
        throw new Error(`Webhook delivery failed with HTTP ${response.status}`);
      }

      await job.updateProgress(100);

      return {
        delivered: true,
        status: response.status,
      };
    }),
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: {
        backoffStrategy,
      },
    }
  );

  worker.on('failed', async (job, error) => {
    if (!job) {
      return;
    }

    await runWithJobContext(job, async () => {
      const maxAttempts = Number(job.opts.attempts ?? 5);
      const exhausted = job.attemptsMade >= maxAttempts;

      logger.error(`Webhook dispatch worker failed job ${job.id}:`, error);

      if (!exhausted) {
        return;
      }

      const eventId = job.data.eventId;

      if (eventId) {
        try {
          await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
              status: 'failed',
              attempts: job.attemptsMade,
              lastError: error.message,
              updatedAt: new Date(),
            },
          });
        } catch (updateError) {
          logger.error(`Failed to mark webhook event ${eventId} as failed:`, updateError);
        }
      }

      await moveToDeadLetter(QUEUE_NAMES.webhookDispatch, String(job.id), job.data, error.message);

      const rawPayload = typeof job.data.payload === 'string' ? job.data.payload : JSON.stringify(job.data.payload);
      const nextRetryAt = new Date(Date.now() + 1000).toISOString();

      try {
        await prisma.webhookDeadLetter.upsert({
          where: { id: eventId },
          create: {
            id: eventId,
            webhookId: job.data.webhookId,
            eventId,
            eventType: job.data.eventType,
            payload: rawPayload,
            attempts: job.attemptsMade,
            lastError: error.message,
            nextRetryAt,
          },
          update: {
            attempts: job.attemptsMade,
            lastError: error.message,
            nextRetryAt,
            updatedAt: new Date(),
          },
        });
      } catch (dlqError) {
        logger.error(`Failed to persist webhook dead letter ${eventId}:`, dlqError);
      }

      try {
        await webhookRetryQueue.add(
          'retry-event',
          {
            webhookId: job.data.webhookId,
            eventId,
            eventType: job.data.eventType,
            payload: rawPayload,
            retryCount: 0,
            requestId: job.data.requestId,
          },
          {
            delay: 1000,
            jobId: `retry-${eventId}-1`,
            removeOnComplete: false,
            removeOnFail: false,
          }
        );
      } catch (enqueueError) {
        logger.error(`Failed to enqueue webhook retry ${eventId}:`, enqueueError);
      }
    });
  });

  worker.on('error', (error) => {
    logger.error('Webhook worker error:', error);
  });

  return worker;
}

/** @deprecated prefer createWebhookDispatchWorker() */
export const webhookDispatchWorker = createWebhookDispatchWorker();

export async function closeWebhookWorker(): Promise<void> {
  await webhookDispatchWorker.close();
  await prisma.$disconnect();
}
