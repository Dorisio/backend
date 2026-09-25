import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { bullConnection, backoffStrategy, moveToDeadLetter, QUEUE_NAMES } from '../queue';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import { executeWithBreaker, CircuitBreakerOpenError } from '../circuit-breaker';

const prisma = new PrismaClient();

export function createWebhookDispatchWorker() {
  const worker = new Worker(
    QUEUE_NAMES.webhookDispatch,
    async (job: Job) => {
      const { webhookId, eventType, payload } = job.data;
      logger.info(`Dispatching webhook ${webhookId} for ${eventType} event`);
      await job.updateProgress(20);

      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
        select: { id: true, url: true, secret: true, active: true },
      });
      if (!webhook) {
        throw new Error(`Webhook ${webhookId} not found`);
      }
      if (!webhook.active) {
        return { delivered: false, status: 0, skipped: 'inactive' };
      }

      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      await job.updateProgress(60);
      const response = await executeWithBreaker('webhook', () =>
        axios.post(webhook.url, payload, {
          headers: {
            'Content-Type': 'application/json',
            'X-Dorisio-Signature': `sha256=${signature}`,
            'X-Dorisio-Event': eventType,
            'X-Dorisio-Delivery-Id': job.id,
          },
          timeout: 10_000,
          validateStatus: () => true,
        })
      ).catch((error: unknown) => {
        if (error instanceof CircuitBreakerOpenError) {
          logger.warn({ webhookId }, 'Webhook circuit breaker open, skipping delivery');
          return null;
        }
        throw error;
      });

      if (response === null) {
        await prisma.webhookEvent.create({
          data: {
            webhookId,
            eventType,
            payload: JSON.stringify(payload),
            status: 'failed',
            attempts: job.attemptsMade + 1,
            lastError: 'Circuit breaker open',
          },
        });
        throw new Error('Webhook delivery skipped: circuit breaker open');
      }

      await prisma.webhookEvent.create({
        data: {
          webhookId,
          eventType,
          payload: JSON.stringify(payload),
          status: response.status >= 200 && response.status < 300 ? 'delivered' : 'failed',
          attempts: job.attemptsMade + 1,
          lastError: response.status >= 300 ? `HTTP ${response.status}` : null,
        },
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Webhook delivery failed with HTTP ${response.status}`);
      }

      await job.updateProgress(100);
      return { delivered: true, status: response.status };
    },
    {
      connection: bullConnection,
      concurrency: config.WORKER_CONCURRENCY,
      settings: { backoffStrategy },
    },
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) {
      await moveToDeadLetter(QUEUE_NAMES.webhookDispatch, String(job.id), job.data, err.message);
    }
  });

  return worker;
}

/** @deprecated prefer createWebhookDispatchWorker() */
export const webhookDispatchWorker = createWebhookDispatchWorker();
