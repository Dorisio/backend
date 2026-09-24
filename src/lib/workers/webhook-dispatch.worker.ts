import { Worker, Job } from 'bullmq';
import { createClient } from 'redis';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';
import crypto from 'crypto';

const redis = createClient({
  url: config.REDIS_URL,
});

const prisma = new PrismaClient();

export const webhookDispatchWorker = new Worker(
  'webhook-dispatch',
  async (job: Job) => {
    const { webhookId, eventType, payload } = job.data;

    logger.info(`Dispatching webhook ${webhookId} for ${eventType} event`);

    try {
      const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });

      if (!webhook) {
        throw new Error(`Webhook ${webhookId} not found`);
      }

      // Create signature for webhook verification
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(JSON.stringify(payload))
        .digest('hex');

      const response = await axios.post(webhook.url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Dorisio-Signature': `sha256=${signature}`,
          'X-Dorisio-Event': eventType,
          'X-Dorisio-Delivery-Id': job.id,
          'X-Request-Id': String(job.data.requestId ?? job.id),
        },
        timeout: 30000,
      });

      // Track successful dispatch
      await prisma.webhookEvent.update({
        where: { id: job.data.eventId },
        data: {
          status: 'delivered',
          attempts: { increment: 1 },
          updatedAt: new Date(),
        },
      });

      logger.info(`Webhook ${webhookId} dispatched successfully (status ${response.status})`);
      return { success: true, webhookId, statusCode: response.status };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      logger.error(`Webhook dispatch failed for ${webhookId}:`, error);

      // Track failed dispatch attempt
      await prisma.webhookEvent.update({
        where: { id: job.data.eventId },
        data: {
          status: 'pending',
          attempts: { increment: 1 },
          lastError: errorMsg,
          updatedAt: new Date(),
        },
      });

      throw error;
    }
  },
  {
    connection: redis as any,
  }
);

webhookDispatchWorker.on('completed', (job) => {
  logger.info(`Webhook dispatch worker completed job ${job.id}`);
});

webhookDispatchWorker.on('failed', (job, err) => {
  logger.error(`Webhook dispatch worker failed job ${job?.id}:`, err);
});
