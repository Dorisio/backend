import { Job } from 'bullmq';
import { allQueues, QUEUE_NAMES } from '../queue';

const queueByName = Object.fromEntries(allQueues.map((q) => [q.name, q]));

export async function getJobStatus(queueName: string, jobId: string) {
  const queue = queueByName[queueName];
  if (!queue) {
    return null;
  }
  const job = await Job.fromId(queue, jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    id: job.id,
    name: job.name,
    queue: queueName,
    state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
    data: job.data,
  };
}

export { QUEUE_NAMES };
