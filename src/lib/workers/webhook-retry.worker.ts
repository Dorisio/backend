import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { bullConnection, backoffStrategy, QUEUE_NAMES, webhookRetryQueue } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { executeWithBreaker, CircuitBreakerOpenError } from '../circuit-breaker';
import { createWebhookSignature } from '../../domains/webhooks/webhook.events';
import { requestIdHeaders } from '../requestContext';
import { withWorkerContext, runWithJobContext } from './middleware';

const prisma = new PrismaClient();

/** Maximum retry attempts for the retry queue. */
const MAX_RETRY_ATTEMPTS = 5;

/** Exponential backoff delays: 1s, 4s, 16s, 64s, then capped at 64s. */
const RETRY_BACKOFF_MS = [1_000, 4_000, 16_000, 64_000];

function retryBackoff(attemptsMade: number): number {
  const index = Math.min(Math.max(attemptsMade, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[index];
}

interface RetryJobData {
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: string;
  retryCount: number;
  requestId?: string;
}

export function createWebhookRetryWorker() {
  const worker = new Worker<RetryJobData>(
    QUEUE_NAMES.webhookRetry,
    withWorkerContext(async (job: Job<RetryJobData>) => {
      const { webhookId, eventId, eventType, payload, retryCount = 0, requestId } = job.data;

      logger.info({ jobId: job.id, webhookId, eventType, attempt: retryCount + 1 }, 'Retrying webhook delivery');
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
        response = await executeWithBreaker('webhook-retry', async () => {
          return axios.post(webhook.url, rawPayload, {
            headers: {
              'Content-Type': 'application/json',
              'X-Dorisio-Signature': signature,
              'X-Dorisio-Event': eventType,
              'X-Dorisio-Delivery-Id': eventId,
              'X-Dorisio-Event-Version': '1',
              ...requestIdHeaders(String(requestId ?? eventId ?? job.id)),
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
          throw error;
        }
      }

      if (response === null) {
        throw new Error('Webhook delivery skipped: circuit breaker open');
      }

      const delivered = response.status >= 200 && response.status < 300;

      if (eventId) {
        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: delivered ? 'delivered' : 'pending',
            attempts: retryCount + 1,
            lastError: delivered ? null : `HTTP ${response.status}`,
            updatedAt: new Date(),
          },
        });
      }

      if (delivered) {
        await prisma.webhookDeadLetter.deleteMany({ where: { eventId } });
        await job.updateProgress(100);
        return { delivered: true, status: response.status, retryCount };
      }

      const nextRetry = retryCount + 1;

      if (nextRetry >= MAX_RETRY_ATTEMPTS) {
        await prisma.webhookDeadLetter.upsert({
          where: { id: eventId },
          create: {
            id: eventId,
            webhookId,
            eventId,
            eventType,
            payload: rawPayload,
            attempts: nextRetry,
            lastError: `HTTP ${response.status}`,
            nextRetryAt: null,
          },
          update: {
            attempts: nextRetry,
            lastError: `HTTP ${response.status}`,
            nextRetryAt: null,
            updatedAt: new Date(),
          },
        });
        await prisma.webhookEvent.update({
          where: { id: eventId },
          data: {
            status: 'failed',
            attempts: nextRetry,
            lastError: `HTTP ${response.status}`,
            updatedAt: new Date(),
          },
        });
        throw new Error(`Webhook delivery failed after ${MAX_RETRY_ATTEMPTS} attempts: HTTP ${response.status}`);
      }

      const delayMs = retryBackoff(nextRetry);
      const nextRetryTime = new Date(Date.now() + delayMs).toISOString();

      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'pending',
          attempts: nextRetry,
          lastError: `HTTP ${response.status}`,
          updatedAt: new Date(),
        },
      });

      await prisma.webhookDeadLetter.upsert({
        where: { id: eventId },
        create: {
          id: eventId,
          webhookId,
          eventId,
          eventType,
          payload: rawPayload,
          attempts: nextRetry,
          lastError: `HTTP ${response.status}`,
          nextRetryAt: nextRetryTime,
        },
        update: {
          attempts: nextRetry,
          lastError: `HTTP ${response.status}`,
          nextRetryAt: nextRetryTime,
          updatedAt: new Date(),
        },
      });

      await job.updateProgress(80);

      await webhookRetryQueue.add(
        'retry-event',
        {
          webhookId,
          eventId,
          eventType,
          payload: rawPayload,
          retryCount: nextRetry,
          requestId,
        },
        {
          delay: delayMs,
          jobId: `retry-${eventId}-${nextRetry}`,
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      logger.info({ jobId: job.id, eventId, retryCount: nextRetry, delayMs }, 'Webhook retry scheduled');
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
      const { webhookId, eventId, eventType, payload, retryCount = 0, requestId } = job.data as RetryJobData;
      const nextRetry = (retryCount || 0) + 1;

      logger.error({ jobId: job.id, eventId, error: error instanceof Error ? error.message : String(error) }, 'Webhook retry worker job failed');

      if (eventId) {
        try {
          await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
              status: 'failed',
              attempts: nextRetry,
              lastError: error instanceof Error ? error.message : String(error),
              updatedAt: new Date(),
            },
          });

          const rawPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);

          await prisma.webhookDeadLetter.upsert({
            where: { id: eventId },
            create: {
              id: eventId,
              webhookId,
              eventId,
              eventType,
              payload: rawPayload,
              attempts: nextRetry,
              lastError: error instanceof Error ? error.message : String(error),
              nextRetryAt: null,
            },
            update: {
              attempts: nextRetry,
              lastError: error instanceof Error ? error.message : String(error),
              nextRetryAt: null,
              updatedAt: new Date(),
            },
          });
        } catch (updateError) {
          logger.error({ eventId, error: updateError }, 'Failed to mark webhook event as failed');
        }
      }
    });
  });

  worker.on('error', (error) => {
    logger.error('Webhook retry worker error:', error);
  });

  return worker;
}

/** @deprecated prefer createWebhookRetryWorker() */
export const webhookRetryWorker = createWebhookRetryWorker();

export async function closeWebhookRetryWorker(): Promise<void> {
  await webhookRetryWorker.close();
  await prisma.$disconnect();
}
