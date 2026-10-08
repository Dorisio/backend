import { Queue, Worker } from 'bullmq';
import { chargeDueSubscriptions } from '../../domains/subscriptions/subscription.charge';

const QUEUE_NAME = 'subscription-billing';

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null as null,
};

export async function startSubscriptionWorker() {
  const queue = new Queue(QUEUE_NAME, { connection });

  // Runs every 5 minutes; jobId keeps it from being registered twice
  await queue.add(
    'charge-due',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'charge-due-subscriptions' },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await chargeDueSubscriptions();
      return { processed: count };
    },
    { connection },
  );

  worker.on('failed', (job, err) => {
    console.error('[subscription-worker] job failed', job?.id, err);
  });

  return worker;
}