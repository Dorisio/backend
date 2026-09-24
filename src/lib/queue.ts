import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from 'redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// Redis connection for BullMQ (using redis client package)
export const redis = createClient({
  url: config.REDIS_URL,
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err) => {
  logger.error('Redis connection error:', err);
});

// Initialize Redis connection
redis.connect().catch((err) => {
  logger.error('Failed to connect to Redis:', err);
});

// Job queues
export const stellarConfirmationQueue = new Queue('stellar-confirmation', {
  connection: redis as any,
});
export const webhookDispatchQueue = new Queue('webhook-dispatch', { connection: redis as any });
export const emailNotificationRedis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const emailNotificationEventsRedis = emailNotificationRedis.duplicate();
export const emailNotificationQueue = new Queue('email-notifications', { connection: emailNotificationRedis as any });

// Queue event handlers
export const stellarConfirmationEvents = new QueueEvents('stellar-confirmation', {
  connection: redis as any,
});

export const webhookDispatchEvents = new QueueEvents('webhook-dispatch', {
  connection: redis as any,
});
export const emailNotificationEvents = new QueueEvents('email-notifications', { connection: emailNotificationEventsRedis as any });

// Initialize queue event listeners
stellarConfirmationEvents.on('completed', ({ jobId }) => {
  logger.info(`Stellar confirmation job ${jobId} completed`);
});

stellarConfirmationEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(`Stellar confirmation job ${jobId} failed: ${failedReason}`);
});

webhookDispatchEvents.on('completed', ({ jobId }) => {
  logger.info(`Webhook dispatch job ${jobId} completed`);
});

webhookDispatchEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(`Webhook dispatch job ${jobId} failed: ${failedReason}`);
});

emailNotificationEvents.on('completed', ({ jobId }) => {
  logger.info({ jobId }, 'Email notification delivered');
});
emailNotificationEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, 'Email notification delivery failed');
});

export async function closeQueues() {
  await stellarConfirmationQueue.close();
  await webhookDispatchQueue.close();
  await emailNotificationQueue.close();
  await stellarConfirmationEvents.close();
  await webhookDispatchEvents.close();
  await emailNotificationEvents.close();
  await emailNotificationRedis.quit();
  await emailNotificationEventsRedis.quit();
  await redis.quit();
}
